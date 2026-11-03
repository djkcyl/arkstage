import * as cheerio from "cheerio";

export function parseIndex(html) {
  const $ = cheerio.load(html), tables = [];
  $("table.wikitable").each((_, table) => {
    const rows = $(table).find("tr").toArray(), books = [];
    const category = $(rows[0]).find("th").first().text().trim();
    let group = "";
    for (const row of rows.slice(1)) {
      const ths = $(row).find("th").toArray(), tds = $(row).find("td").toArray();
      if (!tds.length || !$(tds.at(-1)).find("a[href^='/w/']").length) continue;
      let book;
      if (ths.length > 1) {
        book = $(ths[0]).text().trim();
        group = $(ths[0]).attr("rowspan") ? book : "";
      } else if (ths.length === 1) book = group || $(ths[0]).text().trim();
      else book = group || "未分类";
      if (book && !books.includes(book)) books.push(book);
    }
    if (books.length) tables.push({ category, books });
  });
  const books = [...new Set(tables.flatMap(t => t.books))];
  return { books, main: tables.filter(t => /主线剧情/.test(t.category)).flatMap(t => t.books).filter(b => !/^(特殊|未分类)/.test(b)) };
}

export function parseTaxonomy(raw, index, activities, previous) {
  const sections = new Map(); let section = "";
  const lines = raw.split("\n");
  const matchBook = (name) => {
    if (index.books.includes(name)) return name;
    const candidates = index.books.filter(book => book.startsWith(name));
    if (candidates.length > 1) throw new Error(`Ambiguous book: ${name}`);
    return candidates[0];
  };
  for (let i = 0; i < lines.length; i++) {
    const heading = /^==\s*([^=].*?)\s*==$/.exec(lines[i]);
    if (heading) { section = heading[1].replace(/^主题曲\s*/, "").trim(); continue; }
    const name = /^\|名称=(.+)$/.exec(lines[i]);
    if (name && section && /\{\{\/乐章\s*$/.test(lines[i - 1] ?? "")) {
      const book = matchBook(name[1].trim());
      if (!sections.has(section)) sections.set(section, []);
      if (book) sections.get(section).push(book);
    }
  }
  if (!sections.size || index.main.length < 5) throw new Error("Incomplete PRTS taxonomy/index response");
  const result = [["为了明日", index.main], ...[...sections].filter(([name]) => name !== "为了明日")];
  const collabs = new Set(previous.find(([name]) => name === "联动")?.[1] ?? []);
  activities.filter(a => a.collab).forEach(a => { const book = matchBook(a.short || a.title); if (book) collabs.add(book); });
  result.push(["联动", [...collabs].filter(book => index.books.includes(book))]);
  const claimed = new Set();
  for (const [category, books] of result) for (const book of books) {
    if (claimed.has(book)) throw new Error(`Duplicate taxonomy member: ${category}/${book}`);
    claimed.add(book);
  }
  const oldCount = previous.reduce((sum, [, books]) => sum + books.length, 0);
  if (claimed.size < oldCount * .9) throw new Error("Taxonomy unexpectedly lost more than 10% of its members");
  return result;
}
