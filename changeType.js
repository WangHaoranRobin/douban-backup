const { Client } = require("@notionhq/client");
const jsdom = require("jsdom");
const { JSDOM } = jsdom;
const got = require("got");
const fs = require("fs");

const notion = new Client({
  auth: "secret_eCl03buOceBHRbvEe7jlt9Jfgj9LHGYnFFtqDmrUsmo",
});

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

(async () => {
  let has_more = true;
  let results = [];
  let start_cursor = null;

  while (has_more) {
    const response = await notion.databases.query({
      database_id: "e043a6803faf43cd9d2a9ded57c2f4e9",
      filter: {
        property: "Type",
        select: {
          equals: "Film/TV",
        },
      },
      start_cursor: start_cursor ? start_cursor : undefined,
    });
    results = results.concat(response.results);
    has_more = response.has_more;
    start_cursor = response.next_cursor;
  }

  console.log(results.length);

  for (const item of results) {
    await delay(Math.floor(Math.random() * 1001) + 2500);
    console.log(item.properties.Link.url);
    let type = await getTypeFor(item.properties.Link.url);
    console.log(type);
    ic =
      item.properties.Status.select.name == "Want to"
        ? type == "Film"
          ? "wishMovie"
          : "wishTV"
        : type == "Film"
        ? "finishedMovie"
        : "finishedTV";
    if (type == null) {
      await notion.pages.update({
        page_id: item.id,
        icon: icons[ic],
      });
    } else {
      await notion.pages.update({
        page_id: item.id,
        icon: icons[ic],
        properties: {
          Type: {
            select: {
              name: type,
            },
          },
        },
      });
    }
  }
})();

function delay(time) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

async function getTypeFor(url) {
  let response;
  try {
    response = await got(url);
  } catch (error) {
    console.log(error);
    return null;
  }
  const dom = new JSDOM(response.body);

  // movie item page
  textType =
    dom.window.document.querySelector("#content #recommendations i") != null
      ? dom.window.document
          .querySelector("#content #recommendations i")
          .textContent.trim()
      : null;
  if (textType == null) {
    return null;
  } else if (textType == "喜欢这部电影的人也喜欢") {
    return "Film";
  } else {
    return "TV Series";
  }
}
