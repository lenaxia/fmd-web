-- Harvester quoting edge cases (§13.1). Hand-written; every expected
-- extraction below is asserted in corpus/test/harvester.test.ts.

-- CASE simple-double: plain double-quoted XPath
local a = CreateTXQuery(HTTP.Document).XPathString('//div[@class="title"]')

-- CASE simple-single: plain single-quoted XPath with inner doubles
local b = x.XPath('//meta[@name="description"]/@content')

-- CASE escaped-quote: single-quoted string containing an escaped single quote
local c = x.XPathString('//a[@title="it\'s here"]/@href')

-- CASE long-bracket: [[...]] string (content must not contain ]])
local d = x.XPath([[//div[@data-x='y' and @id="main"]/h1]])

-- CASE long-bracket-levels: [==[...]==] survives inner ]] sequences
local e = x.XPathString([==[//div[@data-json='{"k": [1]}']/span]==])

-- CASE concat-var: literal .. variable .. literal (dynamic)
local f = x.XPathString('(//li[@class="item"])[' .. IDX .. ']/a')

-- CASE concat-literals: adjacent literal concatenation is fully static
local g = x.XPathString('//div' .. '[@class="row"]' .. '/a')

-- CASE comment-fake: a commented-out call must NOT be harvested
-- local h = x.XPathString('//comment-fake')

-- CASE string-fake: a call inside a plain string must NOT be harvested
local pattern = "x.XPathString('//string-fake')"

-- CASE node-context: second argument is a node; first is still harvested
local i = x.XPathString('title', info)

-- CASE json-form: json(...) node-tree dialect
local j = x.XPathString('json(*).data[?(@.type=="main")]')

-- CASE css-form: css() selector dialect
local k = x.XPathString('css(.manga-title)')

-- CASE count-form
local n = x.XPathCount('//div[@class="chapter"]')

-- CASE list-fill: XPathStringAll into a TStrings
x.XPathStringAll('//ul[contains(@class, "chapter")]/a', TASK.PageLinks)

-- CASE href-fill: XPathHREFAll fills two lists
x.XPathHREFAll('//div[@class="row"]/a', LINKS, NAMES)

-- CASE href-title-fill
x.XPathHREFTitleAll('//div[@class="row"]/a', LINKS, NAMES)

-- CASE multiline-longbracket: expression spanning lines inside [[...]]
local m = x.XPath([[
//div[contains(@class, "post-title")]
/*[self::h3 or self::h2]
/a
]])

-- CASE decimal-escape: \65 decodes to 'A'
local o = x.XPathString('//div[@id="\65rticle"]')

-- CASE no-literal: variable-only argument — nothing statically extractable
local p = x.XPathString(someVariable)

-- CASE method-not-query: other dotted calls are ignored
q:Add('//not-a-query')
local r = string.format('//also-not-a-query')

-- CASE inline-create: expression on a fresh CreateTXQuery chain
MANGAINFO.Title = CreateTXQuery(HTTP.Document).XPathString('//h1[@class="entry-title"]')
