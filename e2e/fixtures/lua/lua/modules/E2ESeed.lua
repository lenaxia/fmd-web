-- E2ESeed — the compose/process e2e seed module (fixture lua tree).
--
-- Packaged by e2e/prep.mjs into a codeload-shaped zipball
-- (FMD2-<luaSha10>/lua/...) served by the local mock upstream, so the
-- D20 bootstrap installs it through the REAL module-sync pipeline
-- (fetch → SHA-pin verify → staged Init validation → atomic swap).
--
-- GetInfo is deliberately generic: the manga URL arrives as the `URL`
-- global (the catalog entry's link) and is fetched verbatim, so the
-- same module works against any local mock base (127.0.0.1 in process
-- mode, the `e2e-mock` compose service in container mode).
--
-- Download events (§5.2, the Phase-3 pipeline): the fixture chapter
-- pages list their page CONTAINERS in <div id="pages"> (GetPageNumber
-- fills TASK.PageLinks, PageNumber := count) and each container page
-- carries the real image in <img id="image"> (GetImageURL resolves
-- TASK.PageLinks[WORKID-1] in place) — the classic two-stage FMD2
-- module shape that exercises the 'W' → URL → 'D' marker lifecycle.

function GetInfo()
	MANGAINFO.URL = URL
	if HTTP.GET(MANGAINFO.URL) then
		local x = CreateTXQuery(HTTP.Document)
		MANGAINFO.Title = x.XPathString('//*[@id="manga-title"]')
		MANGAINFO.Authors = x.XPathString('//*[@id="authors"]')
		MANGAINFO.Genres = x.XPathString('//*[@id="genres"]')
		MANGAINFO.Status = x.XPathString('//*[@id="status"]')
		MANGAINFO.Summary = x.XPathString('//*[@id="summary"]')
		MANGAINFO.CoverLink = ''
		x.XPathHREFAll('//*[@id="chapters"]/li/a', MANGAINFO.ChapterLinks, MANGAINFO.ChapterNames)
		return no_error
	else
		return net_problem
	end
end

-- GetPageNumber reports the page COUNT only — the host pads
-- TASK.PageLinks with 'W' up to PageNumber (the FMD2 DoGetPageNumber
-- padding), which is what arms the CS_GETPAGELINK phase.
function GetPageNumber()
	if HTTP.GET(URL) then
		local x = CreateTXQuery(HTTP.Document)
		TASK.PageNumber = x.XPathCount('//*[@id="pages"]//a')
		return true
	else
		return false
	end
end

-- GetImageURL resolves one 'W' slot (WORKID is 1-based): chapter page →
-- the WORKID-th page-container link → the container page's <img id="image">.
function GetImageURL()
	if not HTTP.GET(URL) then
		return false
	end
	local cx = CreateTXQuery(HTTP.Document)
	local container = cx.XPathString('(*//*[@id="pages"]//a)[' .. WORKID .. ']/@href')
	if container == nil or container == '' then
		return false
	end
	if not HTTP.GET(container) then
		return false
	end
	local px = CreateTXQuery(HTTP.Document)
	TASK.PageLinks[WORKID - 1] = px.XPathString('//*[@id="image"]/@src')
	return true
end

function Init()
	local m = NewWebsiteModule()
	m.ID = 'e2ee000000000000000000000000ca7a'
	m.Name = 'E2ESeed'
	m.RootURL = ''
	m.Category = 'English'
	m.OnGetInfo = 'GetInfo'
	m.OnGetPageNumber = 'GetPageNumber'
	m.OnGetImageURL = 'GetImageURL'
end
