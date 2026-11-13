// fmdselftest.pas — unit tests for fmdstrings (replicated uBaseUnit
// helpers) and fmdnormalize (uData.pas:85-207 pipeline).
//
// Expected values are derived from the ORIGINAL Pascal implementations in
// FMD2 (uBaseUnit.pas, httpsendthread.pas, uData.pas) — each test cites the
// line it pins. Run via `fmd_capture selftest`; exits non-zero on failure.
unit fmdselftest;

{$mode objfpc}{$H+}

interface

uses
  Classes, SysUtils, fpjson, fmdstrings, fmdnormalize;

// Runs every test; returns number of failures (0 = all pass).
function RunSelfTests: Integer;

implementation

var
  TestCount: Integer = 0;
  FailCount: Integer = 0;
  CurrentGroup: String = '';

procedure Check(const Name: String; const Actual, Expected: String);
begin
  Inc(TestCount);
  if Actual <> Expected then
  begin
    Inc(FailCount);
    WriteLn(Format('FAIL %s/%s:'#10'  expected: [%s]'#10'  actual:   [%s]',
      [CurrentGroup, Name, Expected, Actual]));
  end;
end;

procedure CheckInt(const Name: String; const Actual, Expected: Integer);
begin
  Check(Name, IntToStr(Actual), IntToStr(Expected));
end;

procedure CheckTrue(const Name: String; const Actual: Boolean);
begin
  if Actual then
    Check(Name, 'true', 'true')
  else
    Check(Name, 'false', 'true');
end;

function NormCase(const RawJSON: String; const Flags: TNormalizeFlags;
  const Key: String): String;
var
  Raw, Out: TJSONObject;
begin
  Raw := TJSONObject(GetJSON(RawJSON));
  Out := TJSONObject.Create;
  try
    NormalizeMangaInfo(Raw, Flags, Out);
    Result := Out.Strings[Key];
  finally
    Out.Free;
    Raw.Free;
  end;
end;

function NormLinks(const RawJSON: String; const Flags: TNormalizeFlags;
  const Key: String): String;
var
  Raw, Out: TJSONObject;
  Arr: TJSONArray;
  I: Integer;
begin
  Raw := TJSONObject(GetJSON(RawJSON));
  Out := TJSONObject.Create;
  try
    NormalizeMangaInfo(Raw, Flags, Out);
    Arr := Out.Arrays[Key];
    Result := '';
    for I := 0 to Arr.Count - 1 do
    begin
      if I > 0 then Result += '|';
      Result += TJSONString(Arr[I]).Value;
    end;
  finally
    Out.Free;
    Raw.Free;
  end;
end;

function NormNum(const RawJSON: String; const Flags: TNormalizeFlags): Integer;
var
  Raw, Out: TJSONObject;
begin
  Raw := TJSONObject(GetJSON(RawJSON));
  Out := TJSONObject.Create;
  try
    NormalizeMangaInfo(Raw, Flags, Out);
    Result := Out.Integers['numChapter'];
  finally
    Out.Free;
    Raw.Free;
  end;
end;

procedure TestTrimChars;
var
  L: TStringList;
begin
  CurrentGroup := 'trim-chars';
  // uBaseUnit.pas:2193 TrimRightChar
  Check('right-comma', TrimRightChar('a,b,,', [',']), 'a,b');
  Check('right-space', TrimRightChar('x  ', [' ']), 'x');
  Check('right-none', TrimRightChar('abc', [',']), 'abc');
  Check('right-all', TrimRightChar(',,', [',']), '');
  // uBaseUnit.pas:2177 TrimLeftChar
  Check('left-space', TrimLeftChar('  x', [' ']), 'x');
  Check('left-mixed', TrimLeftChar('.."x"', ['.', '"']), 'x"');
  // uBaseUnit.pas:2171 TrimChar
  Check('both', TrimChar('  hello  ', [' ']), 'hello');
  // uBaseUnit.pas:1396 TrimStrings — trims and deletes empties
  L := TStringList.Create;
  try
    L.Add('  a ');
    L.Add('   ');
    L.Add('b');
    TrimStrings(L);
    CheckInt('strings-count', L.Count, 2);
    Check('strings-content', L[0] + '/' + L[1], 'a/b');
  finally
    L.Free;
  end;
end;

procedure TestCleanString;
begin
  CurrentGroup := 'clean-string';
  // uBaseUnit.pas:1928 — CR/LF/TAB → space, collapse, trim
  Check('breaks-space', CleanString(' Chapter'#9' '#13#10'Two  '), 'Chapter Two');
  Check('multi-space', CleanString('A   B'), 'A B');
  Check('triple-space', CleanString('A    B'), 'A B');
  Check('empty', CleanString('   '), '');
end;

procedure TestRemoveStringBreaks;
begin
  CurrentGroup := 'remove-string-breaks';
  // uBaseUnit.pas:2153 — raw CR/LF AND literal "\n"/"\r"
  Check('raw', RemoveStringBreaks('a'#10'b'#13'c'#10#13'd'), 'abcd');
  Check('literal', RemoveStringBreaks('a\nb\rc'), 'abc');
  Check('mixed', RemoveStringBreaks('a'#10'\n b'), 'a b');
end;

procedure TestFixWhiteSpace;
begin
  CurrentGroup := 'fix-white-space';
  // uBaseUnit.pas:1913 — NBSP and BOM byte sequences removed
  Check('nbsp', FixWhiteSpace('A'#$C2#$A0'B'), 'AB');
  Check('bom', FixWhiteSpace('A'#$EF#$BB#$BF'B'), 'AB');
  Check('none', FixWhiteSpace('A B'), 'A B');
end;

procedure TestFilters;
begin
  CurrentGroup := 'filters';
  // uBaseUnit.pas:2056 StringFilter — case-insensitive probe via LowerCase
  Check('stringfilter-basic', StringFilter('&lt;b&gt;X&amp;Y&lt;/b&gt;'), '<b>X&Y</b>');
  Check('stringfilter-numeric', StringFilter('Tom&#39;s &#8211; 5'), 'Tom''s - 5');
  Check('stringfilter-case', StringFilter('&LT;a&GT;'), '<a>');
  Check('stringfilter-broken', StringFilter('a&amp;b'), 'a&b');
  // FMD2 quirk (uBaseUnit.pas:88-89): '&euro;'→'©' and '&copy;'→'€' (swapped)
  Check('stringfilter-quirk', StringFilter('&euro; &copy;'), #$C2#$A9 + ' ' + #$E2#$82#$AC);
  // uBaseUnit.pas:2088 HTMLEntitiesFilter — case-SENSITIVE probe
  Check('entities-lower', HTMLEntitiesFilter('caf&eacute;&#233;'), 'caf' + #$C3#$A9 + #$C3#$A9);
  Check('entities-own-row', HTMLEntitiesFilter('&Eacute;'), #$C3#$89);
  // case variant absent from the table: probe misses, value untouched
  Check('entities-upper-untouched', HTMLEntitiesFilter('&EACUTE;'), '&EACUTE;');
  // broken (trailing-''-less) entity of a TABLE row gets repaired
  Check('entities-broken', HTMLEntitiesFilter('x&laquoy'), 'x' + #$C2#$AB + 'y');
  // FMD2 quirk (uBaseUnit.pas:186): '&ndash;' maps to ASCII '-' (not U+2013)
  Check('entities-ndash-ascii', HTMLEntitiesFilter('a&ndash;b'), 'a-b');
  // '&amp;' is a StringFilter row, not an HTMLEntitiesChar row: untouched
  Check('entities-no-amp-row', HTMLEntitiesFilter('x&amp;y'), 'x&amp;y');
  // uBaseUnit.pas:167-173 — German-umlaut block; review regression pin for
  // the '&auml;' row (fmdstrings.pas:168): must decode to U+00E4 = C3 A4.
  // The full tables are byte-verified against the originals by
  // tools/verify-tables.py.
  Check('entities-auml', HTMLEntitiesFilter('K&ouml;ln &auml; &szlig;'),
    'K' + #$C3#$B6 + 'ln ' + #$C3#$A4 + ' ' + #$C3#$9F);
  // FMD2 quirk (uBaseUnit.pas:2088): the Pos probe is case-sensitive but
  // StringReplace carries rfIgnoreCase — so the FIRST table row whose
  // exact-case form is present replaces the case-variants too ('&Uuml;'
  // precedes '&uuml;' in the table → both render as Ü U+00DC)
  Check('entities-probe-replace-asymmetry', HTMLEntitiesFilter('&Uuml;&uuml;&Auml;'),
    #$C3#$9C + #$C3#$9C + #$C3#$84);
  // uBaseUnit.pas:176-180 — μ rows (named + numeric render the same bytes)
  Check('entities-mu', HTMLEntitiesFilter('&mu;&#956;'), #$CE#$BC + #$CE#$BC);
  // uBaseUnit.pas:2119 CommonStringFilter
  Check('common', CommonStringFilter('  Tom &amp; Jerry&#39;s  '), 'Tom & Jerry''s');
  // full chapter-name chain (uData.pas:182-183) with &ndash; → ASCII '-'
  Check('common-ndash-chain', Trim(CleanString(RemoveStringBreaks(
    CommonStringFilter(' Ch. 5 &ndash; End ')))), 'Ch. 5 - End');
end;

procedure TestCleanMultilinedString;
begin
  CurrentGroup := 'clean-multiline';
  // uBaseUnit.pas:1940 — collapse CRLF runs and LF runs to one
  Check('crlf-run', CleanMultilinedString('a'#13#10#13#10#13#10'b'), 'a'#13#10'b');
  Check('lf-run', CleanMultilinedString('a'#10#10'b'), 'a'#10'b');
  Check('mixed', CleanMultilinedString('a'#10#10'b'#13#10#13#10#13#10'c'), 'a'#10'b'#13#10'c');
end;

procedure TestCleanURL;
begin
  CurrentGroup := 'clean-url';
  // uBaseUnit.pas:1964
  Check('collapse', CleanURL('https://site.example/a//b///c'), 'https://site.example/a/b/c');
  Check('leading-slashes', CleanURL('//site.example/x'), 'site.example/x');
  Check('keeps-scheme-slashes', CleanURL('https://a/b'), 'https://a/b');
  Check('trim', CleanURL('  https://a/b  '), 'https://a/b');
end;

procedure TestRemoveHostFromURL;
var
  H, P: String;
begin
  CurrentGroup := 'remove-host';
  // httpsendthread.pas:191 SplitURL + uBaseUnit.pas:969
  Check('full', RemoveHostFromURL('https://site.example/manga/x/ch-1'), '/manga/x/ch-1');
  Check('relative', RemoveHostFromURL('/manga/x/ch-1'), '/manga/x/ch-1');
  Check('root-only', RemoveHostFromURL('/'), '');
  Check('host-only', RemoveHostFromURL('https://site.example'), '');
  Check('host-slash', RemoveHostFromURL('https://site.example/'), '');
  Check('bare-host-path', RemoveHostFromURL('site.example/x/y'), '/x/y');
  Check('port', RemoveHostFromURL('https://site.example:8080/x'), '/x');
  // bare word with no '.'/'/' and no scheme/port: whole word becomes the
  // path (SplitURL turns any non-empty residue into '/'+residue)
  Check('bare-word', RemoveHostFromURL('ch-1'), '/ch-1');
  // host side of SplitURL (AIncludeProtocol/Port defaults True)
  H := ''; P := '';
  SplitURL('https://site.example:8080/x', @H, @P);
  Check('split-host', H, 'https://site.example:8080');
  Check('split-path', P, '/x');
end;

procedure TestRemoveHostFromURLsPair;
var
  Links, Names: TStringList;
begin
  CurrentGroup := 'remove-host-pair';
  // uBaseUnit.pas:983 — empty links delete BOTH entries
  Links := TStringList.Create;
  Names := TStringList.Create;
  try
    Links.Add('https://h.example/a');
    Links.Add('https://h.example');
    Names.Add('A');
    Names.Add('B');
    RemoveHostFromURLsPair(Links, Names);
    CheckInt('pair-count', Links.Count, 1);
    Check('pair-link', Links[0], '/a');
    Check('pair-name', Names[0], 'A');
  finally
    Links.Free;
    Names.Free;
  end;
end;

procedure TestMangaInfoStatusIfPos;
begin
  CurrentGroup := 'status-if-pos';
  // uBaseUnit.pas:2793 + constants :230-233, 'Unknown' frmMain.pas:1010
  Check('empty-search', MangaInfoStatusIfPos(''), '');
  Check('ongoing', MangaInfoStatusIfPos('ongoing'), MangaInfo_StatusOngoing);
  Check('ongoing-case', MangaInfoStatusIfPos('OnGoing'), MangaInfo_StatusOngoing);
  Check('completed', MangaInfoStatusIfPos('Completed'), MangaInfo_StatusCompleted);
  Check('hiatus', MangaInfoStatusIfPos('Hiatus'), MangaInfo_StatusHiatus);
  Check('cancelled', MangaInfoStatusIfPos('Cancelled'), MangaInfo_StatusCancelled);
  Check('unknown', MangaInfoStatusIfPos('Unknown'), MangaInfo_StatusUnknown);
  Check('nomatch', MangaInfoStatusIfPos('dropped'), MangaInfo_StatusUnknown);
  Check('contains-first', MangaInfoStatusIfPos('status: ongoing and complete'),
    MangaInfo_StatusOngoing);
  Check('custom-pipe', MangaInfoStatusIfPos('Series is complete!',
    'ongoing', 'complete|done'), MangaInfo_StatusCompleted);
  Check('custom-pipe-miss', MangaInfoStatusIfPos('Series is complete!',
    'ongoing', 'finished'), MangaInfo_StatusUnknown);
end;

procedure TestNormalizeLinkFallback;
begin
  CurrentGroup := 'norm-link-fallback';
  // uData.pas:112-113
  CheckTrue('fallback', NormCase(
    '{"url":"https://site.example/manga/x","link":""}',
    DefaultNormalizeFlags, 'link') = '/manga/x');
  CheckTrue('no-fallback', NormCase(
    '{"url":"https://site.example/manga/x","link":"/custom"}',
    DefaultNormalizeFlags, 'link') = '/custom');
end;

procedure TestNormalizePadPrune;
begin
  CurrentGroup := 'norm-pad-prune';
  // uData.pas:143-152 — pad names with '', prune to links, then Trim
  CheckTrue('pad', NormLinks(
    '{"chapterLinks":["/a","/b","/c"],"chapterNames":["A"]}',
    DefaultNormalizeFlags, 'chapterNames') = 'A||');
  CheckTrue('prune', NormLinks(
    '{"chapterLinks":["/a"],"chapterNames":["A","B","C"]}',
    DefaultNormalizeFlags, 'chapterNames') = 'A');
  CheckTrue('trim-both', NormLinks(
    '{"chapterLinks":["  /a  "],"chapterNames":["  A "]}',
    DefaultNormalizeFlags, 'chapterNames') = 'A');
end;

procedure TestNormalizeDedup;
begin
  CurrentGroup := 'norm-dedup';
  // uData.pas:154-173 — SameText dedup deletes the EARLIER index;
  // the LAST occurrence's link+name survives. Seed fixture case:
  CheckTrue('last-survives-links', NormLinks(
    '{"chapterLinks":[' +
      '"https://site.example/manga/x/ch-1",' +
      '"https://site.example/manga/x/ch-2",' +
      '"https://SITE.example/manga/x/ch-2"],' +
    '"chapterNames":["Chapter 1","Chapter  2 ","chapter 2"]}',
    DefaultNormalizeFlags, 'chapterLinks') = '/manga/x/ch-1|/manga/x/ch-2');
  CheckTrue('last-survives-names', NormLinks(
    '{"chapterLinks":[' +
      '"https://site.example/manga/x/ch-1",' +
      '"https://site.example/manga/x/ch-2",' +
      '"https://SITE.example/manga/x/ch-2"],' +
    '"chapterNames":["Chapter 1","Chapter  2 ","chapter 2"]}',
    DefaultNormalizeFlags, 'chapterNames') = 'Chapter 1|chapter 2');
  CheckInt('dedup-numchapter', NormNum(
    '{"chapterLinks":[' +
      '"https://site.example/manga/x/ch-1",' +
      '"https://site.example/manga/x/ch-2",' +
      '"https://SITE.example/manga/x/ch-2"],' +
    '"chapterNames":["Chapter 1","Chapter  2 ","chapter 2"]}',
    DefaultNormalizeFlags), 2);
  // triple duplicate: both earlier copies deleted, one entry remains
  CheckTrue('triple', NormLinks(
    '{"chapterLinks":["/a","/A","/a"],"chapterNames":["x","y","z"]}',
    DefaultNormalizeFlags, 'chapterLinks') = '/a');
  // interleaved duplicates pin the ORDER: two dup pairs side by side —
  // each EARLIER copy is deleted at its own index, the last copies keep
  // their relative positions, untouched entries never move
  CheckTrue('interleaved-order-links', NormLinks(
    '{"chapterLinks":["/x","/y","/X","/Y"],"chapterNames":["x1","y1","x2","y2"]}',
    DefaultNormalizeFlags, 'chapterLinks') = '/X|/Y');
  CheckTrue('interleaved-order-names', NormLinks(
    '{"chapterLinks":["/x","/y","/X","/Y"],"chapterNames":["x1","y1","x2","y2"]}',
    DefaultNormalizeFlags, 'chapterNames') = 'x2|y2');
  CheckInt('interleaved-order-num', NormNum(
    '{"chapterLinks":["/x","/y","/X","/Y"],"chapterNames":["x1","y1","x2","y2"]}',
    DefaultNormalizeFlags), 2);
end;

procedure TestNormalizePrefixStrip;
begin
  CurrentGroup := 'norm-prefix-strip';
  // flag OFF (FMDOptions.pas:168 default): names pass cleanup untouched —
  // no prefix stripping
  CheckTrue('flag-off', NormLinks(
    '{"title":"ExampleMan",' +
    '"chapterLinks":["/1","/2","/3","/4"],' +
    '"chapterNames":["ExampleMan Ch. 5","ExampleMan- Ch. 6",' +
      '"NotExampleMan Ch. 7","exampleman extra"]}',
    DefaultNormalizeFlags, 'chapterNames') =
      'ExampleMan Ch. 5|ExampleMan- Ch. 6|NotExampleMan Ch. 7|exampleman extra');
end;

procedure TestNormalizePrefixStripOn;
var
  F: TNormalizeFlags;
begin
  CurrentGroup := 'norm-prefix-strip-on';
  F := DefaultNormalizeFlags;
  F.OptionRemoveMangaNameFromChapter := True;
  CheckTrue('strip', NormLinks(
    '{"title":"ExampleMan",' +
    '"chapterLinks":["/1","/2","/3","/4"],' +
    '"chapterNames":["ExampleMan Ch. 5","ExampleMan- Ch. 6",' +
      '"NotExampleMan Ch. 7","exampleman extra"]}',
    F, 'chapterNames') = 'Ch. 5|Ch. 6|NotExampleMan Ch. 7|extra');
  // name shorter than title is untouched (Length(s2) > j guard)
  CheckTrue('short-name-untouched', NormLinks(
    '{"title":"ExampleMan","chapterLinks":["/1"],"chapterNames":["ExampleMan"]}',
    F, 'chapterNames') = 'ExampleMan');
end;

procedure TestNormalizeFieldCleanup;
var
  F: TNormalizeFlags;
begin
  CurrentGroup := 'norm-fields';
  // uData.pas:115-139 — field cleanup, N/A title fill.
  // NOTE: Title cleanup (CommonStringFilter+RemoveStringBreaks+FixWhiteSpace
  // +Trim) does NOT collapse internal double spaces — only CleanString
  // (chapter names) does. NBSP (U+00A0) is removed entirely by
  // FixWhiteSpace — no space is inserted in its place.
  CheckTrue('title-nbsp', NormCase(
    '{"title":"  Example'#$C2#$A0'Manga  ","chapterLinks":["/a"],"chapterNames":["A"]}',
    DefaultNormalizeFlags, 'title') = 'ExampleManga');
  CheckTrue('title-keeps-inner-space', NormCase(
    '{"title":"  Example  Manga  ","chapterLinks":["/a"],"chapterNames":["A"]}',
    DefaultNormalizeFlags, 'title') = 'Example  Manga');
  CheckTrue('title-na', NormCase(
    '{"title":"  ","chapterLinks":["/a"],"chapterNames":["A"]}',
    DefaultNormalizeFlags, 'title') = 'N/A');
  CheckTrue('authors-trailing-comma', NormCase(
    '{"authors":"One, Two,  ","chapterLinks":["/a"]}',
    DefaultNormalizeFlags, 'authors') = 'One, Two');
  CheckTrue('dash-cleared', NormCase(
    '{"authors":"<a>-","chapterLinks":["/a"]}',
    DefaultNormalizeFlags, 'authors') = '');
  // uData.pas:127 — inner spaces survive; runs of CRLF/LF collapse to one
  CheckTrue('summary-crlf', NormCase(
    '{"summary":" line1 \n\n line2 ","chapterLinks":["/a"]}',
    DefaultNormalizeFlags, 'summary') = 'line1 ' + #10 + ' line2');
  CheckTrue('cover-cleanurl', NormCase(
    '{"coverLink":"https://c.example//img.jpg","chapterLinks":["/a"]}',
    DefaultNormalizeFlags, 'coverLink') = 'https://c.example/img.jpg');
  // arrays joined ', ' (Lua table.concat shape): ' Drama ' keeps its inner
  // padding (cleanup trims ENDS only) — 'Action,  Drama' with two spaces
  CheckTrue('genres-array', NormCase(
    '{"genres":["Action"," Drama "],"chapterLinks":["/a"]}',
    DefaultNormalizeFlags, 'genres') = 'Action,  Drama');
  // status passes through untouched
  CheckTrue('status-untouched', NormCase(
    '{"status":"Completed","chapterLinks":["/a"]}',
    DefaultNormalizeFlags, 'status') = 'Completed');
end;

procedure TestNormalizeHostStripDeletes;
var
  F: TNormalizeFlags;
begin
  CurrentGroup := 'norm-host-strip';
  // uData.pas:175-179 — link reducing to '' deletes the pair entry
  CheckTrue('deletes-empty', NormLinks(
    '{"chapterLinks":["https://h.example","/a"],"chapterNames":["X","Y"]}',
    DefaultNormalizeFlags, 'chapterLinks') = '/a');
  CheckTrue('deletes-empty-names', NormLinks(
    '{"chapterLinks":["https://h.example","/a"],"chapterNames":["X","Y"]}',
    DefaultNormalizeFlags, 'chapterNames') = 'Y');
  CheckInt('deletes-empty-num', NormNum(
    '{"chapterLinks":["https://h.example","/a"],"chapterNames":["X","Y"]}',
    DefaultNormalizeFlags), 1);
  // flag off: hosts kept, nothing deleted
  F := DefaultNormalizeFlags;
  F.isRemoveHostFromChapterLinks := False;
  CheckTrue('flag-off-keeps', NormLinks(
    '{"chapterLinks":["https://h.example/a"],"chapterNames":["X"]}',
    F, 'chapterLinks') = 'https://h.example/a');
end;

procedure TestNormalizeNumChapter;
begin
  CurrentGroup := 'norm-numchapter';
  // uData.pas:205 — NumChapter := ChapterLinks.Count (after dedup/host-strip)
  CheckInt('counts-links', NormNum(
    '{"chapterLinks":["/1","/2","/3","/4"]}', DefaultNormalizeFlags), 4);
  CheckInt('no-links', NormNum('{}', DefaultNormalizeFlags), 0);
end;

function RunSelfTests: Integer;
begin
  TestCount := 0;
  FailCount := 0;
  TestTrimChars;
  TestCleanString;
  TestRemoveStringBreaks;
  TestFixWhiteSpace;
  TestFilters;
  TestCleanMultilinedString;
  TestCleanURL;
  TestRemoveHostFromURL;
  TestRemoveHostFromURLsPair;
  TestMangaInfoStatusIfPos;
  TestNormalizeLinkFallback;
  TestNormalizePadPrune;
  TestNormalizeDedup;
  TestNormalizePrefixStrip;
  TestNormalizePrefixStripOn;
  TestNormalizeFieldCleanup;
  TestNormalizeHostStripDeletes;
  TestNormalizeNumChapter;
  WriteLn(Format('selftest: %d checks, %d failures', [TestCount, FailCount]));
  Result := FailCount;
end;

end.
