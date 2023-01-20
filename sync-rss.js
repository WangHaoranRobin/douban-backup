const { config } = require("dotenv");
const { Client } = require("@notionhq/client");
const dayjs = require("dayjs");
const got = require("got");
const jsdom = require("jsdom");
const { JSDOM } = jsdom;
const Parser = require("rss-parser");
const parser = new Parser();
const { DB_PROPERTIES, PropertyType, sleep } = require("./util");
const fs = require("fs");
const axios = require("axios");

config();

const icons = {
  wishMovie: {
    type: "external",
    external: { url: "https://www.notion.so/icons/movie_green.svg" },
  },
  wishTV: {
    type: "external",
    external: { url: "https://www.notion.so/icons/tv_green.svg" },
  },
  finishedMovie: {
    type: "external",
    external: { url: "https://www.notion.so/icons/movie_blue.svg" },
  },
  finishedTV: {
    type: "external",
    external: { url: "https://www.notion.so/icons/tv_blue.svg" },
  },
};

const RATING_TEXT = {
  很差: 1,
  较差: 2,
  还行: 3,
  推荐: 4,
  力荐: 5,
};
const done = /^(看过|想看|在看)/;
const CATEGORY = {
  movie: "movie",
  music: "music",
  book: "book",
  game: "game",
  drama: "drama",
};
const EMOJI = {
  movie: "🎞",
  music: "🎶",
  book: "📖",
  game: "🕹",
  drama: "💃🏻",
};

const DOUBAN_USER_ID = "178287366"; //process.env.DOUBAN_USER_ID;
const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});
const movieDBID = process.env.NOTION_MOVIE_DATABASE_ID;
console.log("====================================");
console.log("movieDBID: ", movieDBID);
console.log("====================================");
const TMDb_API_KEY = process.env.TMDB_API_KEY;
console.log("====================================");
console.log("TMDb_API_KEY: ", TMDb_API_KEY);
console.log("====================================");
const RAPID_API_KEY = process.env.RAPID_API_KEY;

function delay(time) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

(async () => {
  console.log("Refreshing feeds from RSS...");
  let feed;
  try {
    feed = await parser.parseURL(
      `https://www.douban.com/feed/people/${DOUBAN_USER_ID}/interests`
    );
  } catch (error) {
    console.error("Failed to parse RSS url: ", error);
    process.exit(1);
  }

  let feedData = {};

  feed = feed.items.filter((item) => done.test(item.title)); // care for done status items only for now
  for (let item of feed) {
    const { category, id } = getCategoryAndId(item.title, item.link);
    const dom = new JSDOM(item.content.trim());
    const contents = [...dom.window.document.querySelectorAll("td p")];
    let rating = contents.filter((el) => el.textContent.startsWith("推荐"));
    if (rating.length) {
      rating = rating[0].textContent.replace(/^推荐: /, "").trim();
      rating = RATING_TEXT[rating];
    }
    let comment = contents.filter((el) => el.textContent.startsWith("备注"));
    if (comment.length) {
      comment = comment[0].textContent.replace(/^备注: /, "").trim();
    }
    const result = {
      id,
      link: item.link,
      rating: typeof rating === "number" ? rating : null,
      comment: typeof comment === "string" ? comment : null, // 备注：XXX -> 短评
      time: item.isoDate, // '2021-05-30T06:49:34.000Z',
      update: false,
      status:
        item.title.match(done)[1] == "看过"
          ? "Finished"
          : item.title.match(done)[1] == "在看"
          ? "Watching"
          : "Want to",
    };
    if (!feedData[category]) {
      feedData[category] = [];
    }
    feedData[category].push(result);
  }

  if (feed.length === 0) {
    console.log("No new items.");
    return;
  }

  const categoryKeys = Object.keys(feedData);
  if (categoryKeys.length) {
    for (const cateKey of categoryKeys) {
      try {
        await handleFeed(feedData[cateKey]);
      } catch (error) {
        console.error(`Failed to handle ${cateKey} feed. `, error);
        process.exit(1);
      }
    }
  }

  console.log("All feeds are handled.");
})();

async function handleFeed(feed, category) {
  if (feed.length === 0) {
    console.log(`No new feeds.`);
    return;
  }
  const dbID = movieDBID;

  console.log(`Handling feed...`);
  // query current db to check whether already inserted
  let filtered;
  try {
    filtered = await notion.databases.query({
      database_id: dbID,
      filter: {
        or: feed.map((item) => ({
          property: DB_PROPERTIES.ITEM_LINK,
          url: {
            contains: item.id,
            // use id to check whether an item is already inserted, better than url
            // as url may be http/https, ending with or withour /
          },
        })),
      },
    });
  } catch (error) {
    console.error(
      `Failed to query database to check already inserted items. `,
      error
    );
    process.exit(1);
  }

  let newFeed = [];
  if (filtered.results.length) {
    for (item of feed) {
      let findItem = await filtered.results.reduce(async (acc, i) => {
        // need to fetch property item as the database filter results do not include
        // property contents any more, see https://developers.notion.com/reference/retrieve-a-page-property
        item.ScoreId = i.properties.Score.id;
        item.DateFinishedId = i.properties["Date Finished"].id;
        if (
          i.properties.Link.url.split("/").slice(-2)[0] ==
          item.link.split("/").slice(-2)[0]
        ) {
          if (item.status.trim() != i.properties.Status.select.name.trim()) {
            item.update = true;
            item.notionId = i.id;
            return acc;
          }
          return (await acc).concat(i);
        }
        return acc;
      }, []);
      if (!findItem.length) {
        newFeed = newFeed ? newFeed.concat(item) : [item];
      } // if length != 0 means can find item in the filtered results, means this item already in db
    }
  }

  feed = newFeed;

  console.log(`There are total ${feed.length} new item(s) need to insert.`);

  for (item of feed) {
    let itemData;
    try {
      delay(1000);
      itemData = await fetchItem(item.link);
      itemData.update = item.update;
      itemData.Status = item.status;
      itemData.Rating =
        item.rating == 5
          ? "⭐️⭐️⭐️⭐️⭐️"
          : item.rating == 4
          ? "⭐️⭐️⭐️⭐️"
          : item.rating == 3
          ? "⭐️⭐️⭐️"
          : item.rating == 2
          ? "⭐️⭐️"
          : item.rating == 1
          ? "⭐️"
          : "";
      itemData.Link = item.link;
      itemData[DB_PROPERTIES.RATING_DATE] = dayjs(item.time).format(
        "YYYY-MM-DD"
      );
      itemData.id = item.notionId;
    } catch (error) {
      console.error(error);
    }

    console.log(itemData);
    console.log("itemData");
    // continue;

    if (itemData) {
      await addToNotion(itemData);
      await sleep(1000);
    }
  }
  console.log(`Feed done.`);
  console.log("====================");
}

function getCategoryAndId(title, link) {
  let m = title.match(done);
  m = m[1];
  let res, id;
  switch (m) {
    case "看过":
    case "在看":
    case "想看":
      if (link.startsWith("http://movie.douban.com/")) {
        res = CATEGORY.movie; // "看过" maybe 舞台剧
        id = link.match(/movie\.douban\.com\/subject\/(\d+)\/?/);
        id = id[1]; // string
      } else {
        res = CATEGORY.drama; // 舞台剧
        id = link.match(/www\.douban\.com\/location\/drama\/(\d+)\/?/);
        id = id[1]; // string
      }
      break;
    case "读过":
      res = CATEGORY.book;
      id = link.match(/book\.douban\.com\/subject\/(\d+)\/?/);
      id = id[1]; // string
      break;
    case "听过":
      res = CATEGORY.music;
      id = link.match(/music\.douban\.com\/subject\/(\d+)\/?/);
      id = id[1]; // string
      break;
    case "玩过":
      res = CATEGORY.game;
      id = link.match(/www\.douban\.com\/game\/(\d+)\/?/);
      id = id[1]; // string
      break;
    default:
      break;
  }
  return { category: res, id };
}

async function fetchItem(link) {
  console.log(`Fetching movie item with link: ${link}`);
  const itemData = {};
  const response = await got(link);
  const dom = new JSDOM(response.body);

  typeInfo = dom.window.document
    .querySelector("#content #recommendations i")
    .textContent.trim();

  itemData.Type = !typeInfo
    ? "Film/TV"
    : typeInfo == "喜欢这部电影的人也喜欢"
    ? "Film"
    : "TV Series";
  itemData.OriginalTitle = dom.window.document
    .querySelector('#content h1 [property="v:itemreviewed"]')
    .textContent.trim();
  itemData.PosterUrl = dom.window.document
    .querySelector("#mainpic img")
    ?.src.replace(/\.webp$/, " jpg");

  let imdbId = dom.window.document
    .querySelector("#content #info")
    .textContent.trim();
  if (imdbId.includes("IMDb:")) {
    imdbId = imdbId.split("IMDb:")[1].trim();
    imdbId = imdbId.split(" ")[0].trim();
    itemData.IMDb = imdbId;

    imdbExist: if (imdbId) {
      try {
        const options = {
          method: "GET",
          url: "https://streaming-availability.p.rapidapi.com/get/basic",
          params: { country: "us", imdb_id: imdbId, output_language: "en" },
          headers: {
            "X-RapidAPI-Key": RAPID_API_KEY,
            "X-RapidAPI-Host": "streaming-availability.p.rapidapi.com",
          },
        };
        // Try to get streaming availability
        const media_data = (await axios.request(options)).data;
        if (media_data) {
          // Get poster url 780 p
          const poster_url = media_data.posterURLs["780"]
            ? media_data.posterURLs["780"]
            : media_data.posterURLs[media_data.posterURLs.length - 1];
          // Get Title and original title
          const title = media_data.title;
          const original_title = media_data.originalTitle;
          // Get Year
          const year = media_data.year;
          // Get director
          const directors = media_data.significants;
          // Get TMDb Id
          const TMDb_Id = media_data.tmdbID;
          // Get Streaming availability
          const streaming_availability = Object.keys(media_data.streamingInfo);

          if (title) {
            itemData.PosterUrl = poster_url;
            itemData.Title = title;
            itemData.OriginalTitle = original_title;
            itemData.Year = year;
            itemData.Directors = directors;
            itemData.TMDbId = TMDb_Id;
            itemData.StreamingAvailability = streaming_availability;
          }
        }
      } catch (error) {
        console.log("====================================");
        console.log("Trying to get media details from TMDb");
        console.log("====================================");
        // Get TMDb Id using IMDb Id
        const options = {
          method: "GET",
          url: `https://api.themoviedb.org/3/find/${imdbId}`,
          params: {
            api_key: TMDb_API_KEY,
            language: "en-US",
            external_source: "imdb_id",
          },
        };

        const response = (await axios.request(options)).data;

        if (itemData.Type == "Film") {
          if (!response.movie_results.length) {
            console.log("====================================");
            console.log("No movie found");
            console.log("====================================");
            break imdbExist;
          }
          const TMDb_Id = response.movie_results[0].id;
          const options = {
            method: "GET",
            url: `https://api.themoviedb.org/3/movie/${TMDb_Id}`,
            params: { api_key: TMDb_API_KEY, language: "en-US" },
          };
          const media_data = (await axios.request(options)).data;
          const options_credit = {
            method: "GET",
            url: `https://api.themoviedb.org/3/movie/${TMDb_Id}/credits`,
            params: { api_key: TMDb_API_KEY, language: "en-US" },
          };
          const media_data_credit = (await axios.request(options_credit)).data;
          if (media_data) {
            itemData.PosterUrl =
              "https://image.tmdb.org/t/p/original/" + media_data.poster_path;
            itemData.Title = media_data.title;
            itemData.OriginalTitle = media_data.original_title;
            itemData.Year = Number(media_data.release_date.split("-")[0]);
            itemData.Directors = media_data_credit.crew
              .filter((item) => item.job == "Director")
              .map((item) => item.name);
            itemData.TMDbId = TMDb_Id.toString();
          }
        } else if (itemData.Type == "TV Series") {
          if (!response.tv_results.length) {
            console.log("====================================");
            console.log("No TV Series found");
            console.log("====================================");
            break imdbExist;
          }
          const TMDb_Id = response.tv_results[0].id;
          const options = {
            method: "GET",
            url: `https://api.themoviedb.org/3/tv/${TMDb_Id}`,
            params: { api_key: TMDb_API_KEY, language: "en-US" },
          };
          const media_data = (await axios.request(options)).data;
          const options_credit = {
            method: "GET",
            url: `https://api.themoviedb.org/3/tv/${TMDb_Id}/credits`,
            params: { api_key: TMDb_API_KEY, language: "en-US" },
          };
          const media_data_credit = (await axios.request(options_credit)).data;
          if (media_data) {
            itemData.PosterUrl =
              "https://image.tmdb.org/t/p/original/" + media_data.poster_path;
            itemData.Title = media_data.name;
            itemData.OriginalTitle = media_data.original_name;
            itemData.Year = Number(media_data.first_air_date.split("-")[0]);
            itemData.Directors = media_data_credit.crew
              .filter((item) => item.job == "Director")
              .map((item) => item.name);
            itemData.TMDbId = TMDb_Id.toString();
          }
        }
      }
    }
  }

  return itemData;
}

async function addToNotion(itemData) {
  console.log("Going to insert ", itemData.Title);
  try {
    let ic =
      itemData.Status == "Want to"
        ? itemData.Type == "Film"
          ? "wishMovie"
          : "wishTV"
        : itemData.Type == "Film"
        ? "finishedMovie"
        : "finishedTV";
    if (itemData.update) {
      if (itemData.Status != "Want to") {
        await notion.pages.update({
          page_id: itemData.id,
          icon: icons[ic],
          properties: {
            Type: {
              select: {
                name: itemData.Type,
              },
            },
            Status: {
              select: {
                name: itemData.Status,
              },
            },
            Score: {
              select: {
                name: itemData.Rating,
              },
            },
            "Date Finished": {
              date: {
                start: itemData["Date Finished"],
              },
            },
          },
        });
      } else {
        await notion.pages.update({
          page_id: itemData.id,
          icon: icons[ic],
          properties: {
            Type: {
              select: {
                name: itemData.Type,
              },
            },
            Status: {
              select: {
                name: itemData.Status,
              },
            },
            Score: {
              id: itemData.ScoreId,
              select: null,
            },
            "Date Finished": {
              id: itemData.DateFinishedId,
              date: null,
            },
          },
        });
      }
    } else {
      let newPage = {
        parent: {
          type: "database_id",
          database_id: movieDBID,
        },
        icon: icons[ic],
        properties: {
          Type: {
            select: {
              name: itemData.Type,
            },
          },
          Name: {
            title: [
              {
                text: {
                  content: itemData.OriginalTitle,
                },
              },
            ],
          },
          Status: {
            select: {
              name: itemData.Status,
            },
          },
          Link: {
            url: itemData.Link,
          },
          "IMDb Id": {
            rich_text: [
              {
                text: {
                  content: itemData.IMDb ? itemData.IMDb : "N/A",
                },
              },
            ],
          },
          "TMDb Id": {
            rich_text: [
              {
                text: {
                  content: itemData.TMDbId ? itemData.TMDbId : "N/A",
                },
              },
            ],
          },
          "English Title": {
            rich_text: [
              {
                text: {
                  content: itemData.Title
                    ? itemData.Title
                    : itemData.OriginalTitle,
                },
              },
            ],
          },
        },
        children: [
          {
            object: "block",
            image: {
              type: "external",
              external: {
                url: itemData.PosterUrl,
              },
            },
          },
        ],
      };
      if (itemData.Year) {
        newPage.properties["Year"] = {
          number: itemData.Year,
        };
      }
      if (
        itemData.StreamingAvailability &&
        itemData.StreamingAvailability.length
      ) {
        newPage.properties["Streaming Availability"] = {
          multi_select: itemData.StreamingAvailability.map((s) => {
            return {
              name: s,
            };
          }),
        };
      }
      if (itemData.Directors && itemData.Directors.length) {
        newPage.properties["Creator"] = {
          multi_select: itemData.Directors.map((d) => {
            return {
              name: d,
            };
          }),
        };
      }
      if (itemData.Status == "Want to") {
        await notion.pages.create(newPage);
      } else {
        newPage.Score = {
          select: {
            name: itemData.Rating,
          },
        };
        newPage["Date Finished"] = {
          date: {
            start: itemData["Date Finished"],
          },
        };
        await notion.pages.create(newPage);
      }
    }
  } catch (error) {
    console.warn(
      "Failed to create " +
        itemData.Name +
        `(${itemData.Link})` +
        " with error: ",
      error
    );
  }
}
