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
      console.error(link, error);
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

  let imdbId = dom.window.document
    .querySelector("#content #info")
    .textContent.trim();
  if (imdbId.includes("IMDb:")) {
    imdbId = imdbId.split("IMDb:")[1].trim();
    itemData.IMDb = imdbId;
  }

  typeInfo = dom.window.document
    .querySelector("#content #recommendations i")
    .textContent.trim();

  itemData.Type = !typeInfo
    ? "Film/TV"
    : typeInfo == "喜欢这部电影的人也喜欢"
    ? "Film"
    : "TV Series";
  itemData.Name = dom.window.document
    .querySelector('#content h1 [property="v:itemreviewed"]')
    .textContent.trim();
  itemData.Thumbnail = dom.window.document
    .querySelector("#mainpic img")
    ?.src.replace(/\.webp$/, ".jpg");

  return itemData;
}

async function addToNotion(itemData) {
  console.log("Going to insert ", itemData.Name);
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
      if (itemData.Status == "Want to") {
        await notion.pages.create({
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
                    content: itemData.Name,
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
          },
          children: [
            {
              object: "block",
              image: {
                type: "external",
                external: {
                  url: itemData.Thumbnail,
                },
              },
            },
          ],
        });
      } else {
        await notion.pages.create({
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
                    content: itemData.Name,
                  },
                },
              ],
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
            Link: {
              url: itemData.Link,
            },
          },
          children: [
            {
              object: "block",
              image: {
                type: "external",
                external: {
                  url: itemData.Thumbnail,
                },
              },
            },
          ],
        });
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
