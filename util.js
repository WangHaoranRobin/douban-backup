const DB_PROPERTIES = {
  // movie
  POSTER: "海报", // common
  TITLE: "Name", // common
  RATING: "Score", // common
  RATING_DATE: "Date Finished", // common
  COMMENTS: "我的短评", // common
  YEAR: "上映年份",
  DIRECTORS: "导演",
  ACTORS: "主演",
  GENRE: "类型", // movie, game, drama
  ITEM_LINK: "Link", // common
  IMDB_LINK: "IMDb 链接",
  // music
  RELEASE_DATE: "发行日期", // music and game
  MUSICIAN: "音乐家",
  // book
  PUBLICATION_DATE: "出版日期",
  PUBLISHING_HOUSE: "出版社",
  WRITER: "作者",
  ISBN: "ISBN",
};

const PropertyType = {
  POSTER: "file",
  TITLE: "title",
  RATING: "multi_select",
  RATING_DATE: "date",
  COMMENTS: "rich_text",
  YEAR: "number",
  DIRECTORS: "rich_text",
  ACTORS: "rich_text",
  GENRE: "multi_select",
  ITEM_LINK: "url",
  IMDB_LINK: "url",
  RELEASE_DATE: "date",
  MUSICIAN: "rich_text",
  PUBLICATION_DATE: "date",
  PUBLISHING_HOUSE: "rich_text",
  WRITER: "rich_text",
  ISBN: "number",
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  DB_PROPERTIES,
  PropertyType,
  sleep,
};
