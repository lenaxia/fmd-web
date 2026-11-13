// fmdstrings.pas — pure string helpers replicated from FMD2's uBaseUnit.pas
// (copied-by-semantics; uBaseUnit itself pulls LCL units and is NOT linked).
//
// Provenance & license: derived from FMD2 (https://github.com/dazedcat19/
// FMD2 — canonical home; formerly rombinary/fmd2) baseunits/uBaseUnit.pas,
// baseunits/httpsendthread.pas and
// baseunits/FMDOptions.pas, which are GPLv2
// ("File: uBaseUnit.pas License: GPLv2 This unit is a part of Free Manga
// Downloader"). This replication is therefore distributed under GPLv2 as
// well; the tables and algorithms are byte-for-byte equivalent (verified
// against FMD2 @ 97c903b "KomikStation: Change domain (#3364)" — see
// fmdselftest.pas for the behavioral pins).
//
// Every function here mirrors the original implementation byte-for-byte in
// behavior (byte-wise Pos/StringReplace/LowerCase/SameText, ANSI semantics,
// UTF-8 byte sequences treated as opaque data), so the capture harness
// produces the same results FMD2 would. Where a helper depends on FPC's
// regexpr unit (CleanURL), the identical library call is used.
//
// Original sources (FMD2 @ 97c903b "KomikStation: Change domain (#3364)"):
//   - uBaseUnit.pas:1507  StringOfString
//   - uBaseUnit.pas:2177  TrimLeftChar / :2193 TrimRightChar / :2171 TrimChar
//   - uBaseUnit.pas:1396  TrimStrings
//   - uBaseUnit.pas:62    StringFilterChar table
//   - uBaseUnit.pas:101   HTMLEntitiesChar table
//   - uBaseUnit.pas:2056  StringFilter / :2088 HTMLEntitiesFilter
//   - uBaseUnit.pas:2119  CommonStringFilter / :2153 RemoveStringBreaks
//   - uBaseUnit.pas:1913  FixWhiteSpace / :1928 CleanString
//   - uBaseUnit.pas:1940  CleanMultilinedString
//   - uBaseUnit.pas:1964  CleanURL
//   - uBaseUnit.pas:230   MangaInfo_Status* constants
//   - uBaseUnit.pas:2793  MangaInfoStatusIfPos
//   - httpsendthread.pas:152 SplitURL (poschar :179 / cleanuri) — the
//     URL-splitting primitive; impl :191
//   - uBaseUnit.pas:969   RemoveHostFromURL (SplitURL wrapper)
//   - uBaseUnit.pas:983   RemoveHostFromURLsPair
//   - FMDOptions.pas:168  OptionRemoveMangaNameFromChapter (default False)
unit fmdstrings;

{$mode objfpc}{$H+}

interface

uses
  Classes, SysUtils, RegExpr;

const
  // uBaseUnit.pas:230-233
  MangaInfo_StatusCompleted = '0';
  MangaInfo_StatusOngoing   = '1';
  MangaInfo_StatusHiatus    = '2';
  MangaInfo_StatusCancelled = '3';
  // frmMain.pas:1010 RS_InfoStatus_Unknown
  MangaInfo_StatusUnknown   = 'Unknown';

  // uBaseUnit.pas:62-98 — exact copy
  StringFilterChar: array [0..35] of array [0..1] of String = (
    (#10, '\n'),
    (#13, '\r'),
    ('&#x27;', ''''),
    ('&#33;', '!'),
    ('&#36;', '$'),
    ('&#37;', '%'),
    ('&#38;', '&'),
    ('&#39;', ''''),
    ('&#033;', '!'),
    ('&#036;', '$'),
    ('&#037;', '%'),
    ('&#038;', '&'),
    ('&#039;', ''''),
    ('&#8211;', '-'),
    ('&gt;', '>'),
    ('&lt;', '<'),
    ('&amp;', '&'),
    ('&ldquo;', '"'),
    ('&rdquo;', '"'),
    ('&quot;', '"'),
    ('&lsquo;', ''''),
    ('&rsquo;', ''''),
    ('&nbsp;', ' '),
    ('&cent;', #194#162),
    ('&pound;', #194#163),
    ('&yen;', #194#165),
    ('&euro;', #194#169),
    ('&copy;', #226#130#172),
    ('&reg;', #194#174),
    ('［', '['),
    ('］', ']'),
    ('（', '('),
    ('）', ')'),
    ('&frac12;', #194#189),
    ('&deg;', #194#176),
    ('&sup2;', #194#178)
    );

  // uBaseUnit.pas:101-190 — exact copy (non-ASCII rendered as UTF-8 byte
  // escapes so the unit compiles codepage-independently)
  HTMLEntitiesChar: array [0..82] of array [0..1] of String = (
    ('&#171;', #194#171),
    ('&#176;', #194#176),
    ('&Agrave;', #195#128),
    ('&#192;', #195#128),
    ('&Aacute;', #195#129),
    ('&#193;', #195#129),
    ('&Acirc;', #195#130),
    ('&#194;', #195#130),
    ('&Atilde;', #195#131),
    ('&ccedil;', #195#167),
    ('&Egrave;', #195#136),
    ('&Eacute;', #195#137),
    ('&Ecirc;', #195#138),
    ('&#202;', #195#138),
    ('&Etilde;', #225#186#188),
    ('&Igrave;', #195#140),
    ('&Iacute;', #195#141),
    ('&Itilde;', #196#168),
    ('&ETH;', #196#144),
    ('&Ograve;', #195#146),
    ('&Oacute;', #195#147),
    ('&Ocirc;', #195#148),
    ('&#212;', #195#148),
    ('&Otilde;', #195#149),
    ('&Ugrave;', #195#153),
    ('&Uacute;', #195#154),
    ('&Yacute;', #195#157),
    ('&#221;', #195#157),
    ('&agrave;', #195#160),
    ('&#224;', #195#160),
    ('&aacute;', #195#161),
    ('&#225;', #195#161),
    ('&acirc;', #195#162),
    ('&#226;', #195#162),
    ('&atilde;', #195#163),
    ('&#227;', #195#163),
    ('&#231;', #195#167),
    ('&egrave;', #195#168),
    ('&#232;', #195#168),
    ('&eacute;', #195#169),
    ('&#233;', #195#169),
    ('&etilde;', #225#186#189),
    ('&ecirc;', #195#170),
    ('&#234;', #195#170),
    ('&igrave;', #195#172),
    ('&#236;', #195#172),
    ('&iacute;', #195#173),
    ('&#237;', #195#173),
    ('&itilde;', #196#169),
    ('&#238;', #195#174),
    ('&eth;', #196#145),
    ('&ograve;', #195#178),
    ('&#242;', #195#178),
    ('&oacute;', #195#179),
    ('&#243;', #195#179),
    ('&ocirc;', #195#180),
    ('&#244;', #195#180),
    ('&otilde;', #195#181),
    ('&#245;', #195#181),
    ('&ugrave;', #195#185),
    ('&#249;', #195#185),
    ('&uacute;', #195#186),
    ('&#250;', #195#186),
    ('&yacute;', #195#189),
    ('&#253;', #195#189),
    ('&#8217;', ''''),
    ('&#8220;', '"'),
    ('&#8221;', '"'),
    ('&#8230;', '...'),
    ('&Auml;', #195#132),
    ('&auml;', #195#164),
    ('&Ouml;', #195#150),
    ('&ouml;', #195#182),
    ('&Uuml;', #195#156),
    ('&uuml;', #195#188),
    ('&szlig;', #195#159),
    ('&mu;', #206#188),
    ('&#956;', #206#188),
    ('&raquo;', #194#187),
    ('&laquo;', #194#171),
    ('&#8216;', #226#128#152),
    ('&ndash;', '-'),
    ('&gamma;', #206#179)
    );

function StringOfString(c: String; l: Integer): String;
function TrimLeftChar(const Source: String; const Chars: TSysCharSet): String;
function TrimRightChar(const Source: String; const Chars: TSysCharSet): String;
function TrimChar(const Source: String; const Chars: TSysCharSet): String;
procedure TrimStrings(TheStrings: TStrings);
function StringFilter(const Source: String): String;
function HTMLEntitiesFilter(const Source: String): String;
function CommonStringFilter(const Source: String): String;
function CleanString(const S: String): String;
function CleanMultilinedString(const S: String; MaxLineEnding: Integer = 1): String;
function FixWhiteSpace(const S: String): String;
function RemoveStringBreaks(const Source: String): String;
function CleanURL(const URL: String): String;
procedure SplitURL(const AURL: String; const AHost, APath: PString;
  const AIncludeProtocol: Boolean = True; const AIncludePort: Boolean = True);
function RemoveHostFromURL(URL: String): String;
procedure RemoveHostFromURLsPair(const URLs, Names: TStringList);
function MangaInfoStatusIfPos(const SearchStr: String; const OngoingStr: String = 'ongoing';
  const CompletedStr: String = 'completed'; const HiatusStr: String = 'hiatus';
  const CancelledStr: String = 'cancelled'): String;

implementation

// uBaseUnit.pas:1507
function StringOfString(c: String; l: Integer): String;
var
  i: Integer;
begin
  Result := '';
  if c = '' then Exit;
  if l < 1 then Exit;
  for i := 1 to l do
    Result += c;
end;

// uBaseUnit.pas:2177
function TrimLeftChar(const Source: String; const Chars: TSysCharSet): String;
var
  i, j: Longint;
begin
  Result := Source;
  i := Length(Result);
  if i > 0 then
  begin
    j := 1;
    while (j <= i) and (Result[j] in Chars) do
      Inc(j);
    if j > 1 then
      Delete(Result, 1, j - 1);
  end;
end;

// uBaseUnit.pas:2193
function TrimRightChar(const Source: String; const Chars: TSysCharSet): String;
var
  i, j: Longint;
begin
  Result := Source;
  i := Length(Result);
  if i > 0 then
  begin
    j := i;
    while (j > 0) and (Result[j] in Chars) do
      Dec(j);
    if j <> i then
      SetLength(Result, j);
  end;
end;

// uBaseUnit.pas:2171
function TrimChar(const Source: String; const Chars: TSysCharSet): String;
begin
  Result := TrimLeftChar(Source, Chars);
  Result := TrimRightChar(Result, Chars);
end;

// uBaseUnit.pas:1396 — trims every entry, deleting the empty ones
procedure TrimStrings(TheStrings: TStrings);
var
  i: Integer;
begin
  if TheStrings = nil then Exit;
  if TheStrings.Count > 0 then
  begin
    i := 0;
    while i < TheStrings.Count do begin
      TheStrings[i] := Trim(TheStrings[i]);
      if TheStrings[i] = '' then TheStrings.Delete(i)
      else Inc(i);
    end;
  end;
end;

// uBaseUnit.pas:2056 — case-insensitive replace; first pass replaces full
// entities, second pass repairs broken (trailing-';'-less) entities
function StringFilter(const Source: String): String;
var
  i: Integer;
begin
  Result := Source;
  if Length(Source) = 0 then
    Exit;

  for i := Low(StringFilterChar) to High(StringFilterChar) do
  begin
    if Pos(StringFilterChar[i, 0], LowerCase(Result)) > 0 then
      Result := StringReplace(Result, StringFilterChar[i, 0], StringFilterChar[i, 1],
        [rfIgnoreCase, rfReplaceAll]);
  end;

  // broken entities
  for i := Low(StringFilterChar) to High(StringFilterChar) do
  begin
    if Length(StringFilterChar[i, 0]) > 1 then
    begin
      if StringFilterChar[i, 0][Length(StringFilterChar[i, 0])] = ';' then
      begin
        if Pos(LeftStr(StringFilterChar[i, 0], Length(StringFilterChar[i, 0]) - 1),
          LowerCase(Result)) > 0 then
          Result := StringReplace(Result, LeftStr(StringFilterChar[i, 0],
            Length(StringFilterChar[i, 0]) - 1), StringFilterChar[i, 1],
            [rfIgnoreCase, rfReplaceAll]);
      end;
    end;
  end;
end;

// uBaseUnit.pas:2088 — same two-pass shape as StringFilter, but Pos probes
// are case-sensitive on Result (only StringReplace is case-insensitive)
function HTMLEntitiesFilter(const Source: String): String;
var
  i: Integer;
begin
  Result := Source;
  if Length(Source) = 0 then
    Exit;

  for i := Low(HTMLEntitiesChar) to High(HTMLEntitiesChar) do
  begin
    if Pos(HTMLEntitiesChar[i, 0], Result) > 0 then
      Result := StringReplace(Result, HTMLEntitiesChar[i, 0], HTMLEntitiesChar[i, 1],
        [rfIgnoreCase, rfReplaceAll]);
  end;

  // broken entities
  for i := Low(HTMLEntitiesChar) to High(HTMLEntitiesChar) do
  begin
    if Length(HTMLEntitiesChar[i, 0]) > 1 then
    begin
      if HTMLEntitiesChar[i, 0][Length(HTMLEntitiesChar[i, 0])] = ';' then
      begin
        if Pos(LeftStr(HTMLEntitiesChar[i, 0], Length(HTMLEntitiesChar[i, 0]) - 1), Result) > 0 then
          Result := StringReplace(Result, LeftStr(HTMLEntitiesChar[i, 0],
            Length(HTMLEntitiesChar[i, 0]) - 1), HTMLEntitiesChar[i, 1],
            [rfIgnoreCase, rfReplaceAll]);
      end;
    end;
  end;
end;

// uBaseUnit.pas:2119
function CommonStringFilter(const Source: String): String;
begin
  Result := Source;
  if Source = '' then Exit;
  Result := Trim(HTMLEntitiesFilter(StringFilter(Trim(Source))));
end;

// uBaseUnit.pas:1928
function CleanString(const S: String): String;
begin
  Result := Trim(S);
  if Result = '' then Exit;
  Result := StringReplace(Result, #13, ' ', [rfReplaceAll]);
  Result := StringReplace(Result, #10, ' ', [rfReplaceAll]);
  Result := StringReplace(Result, #9, ' ', [rfReplaceAll]);
  while Pos('  ', Result) > 0 do
    Result := StringReplace(Result, '  ', ' ', [rfReplaceAll]);
  Result := Trim(Result);
end;

// uBaseUnit.pas:1940 — collapses runs of CRLF (and lone-LF) to MaxLineEnding
function CleanMultilinedString(const S: String; MaxLineEnding: Integer): String;
var
  rn, rnp, n, np: String;
begin
  Result := Trim(s);
  if Result = '' then Exit;
  if MaxLineEnding < 1 then MaxLineEnding := 1;

  rn := StringOfString(#13#10, MaxLineEnding);
  rnp := rn + #13#10;
  while Pos(rnp, Result) > 0 do
    Result := StringReplace(Result, rnp, rn, [rfReplaceAll]);

  n := StringOfChar(#10, MaxLineEnding);
  np := n + #10;
  while Pos(np, Result) > 0 do
    Result := StringReplace(Result, np, n, [rfReplaceAll]);
end;

// uBaseUnit.pas:1913 — strips UTF-8 NBSP (U+00A0) and BOM (U+FEFF)
function FixWhiteSpace(const S: String): String;
const
  R: array [0..1] of string = (
    #$C2#$A0,     // no-break space  / &nbsp  U+00A0 #160
    #$EF#$BB#$BF  // zero width no-break / BOM U+FEFF
    );
var
  v: String;
begin
  Result := S;
  if Result = '' then Exit;
  for v in R do
    Result := StringReplace(Result, v, '', [rfReplaceAll]);
end;

// uBaseUnit.pas:2153 — also strips the LITERAL "\n"/"\r" sequences
function RemoveStringBreaks(const Source: String): String;
begin
  Result := Source;
  if Length(Result) = 0 then
    Exit;
  Result := StringReplace(Result, #10, '', [rfReplaceAll]);
  Result := StringReplace(Result, #13, '', [rfReplaceAll]);
  Result := StringReplace(Result, '\n', '', [rfReplaceAll]);
  Result := StringReplace(Result, '\r', '', [rfReplaceAll]);
end;

// uBaseUnit.pas:1964 — protocol-preserving duplicate-slash collapse via the
// same FPC RegExpr call FMD2 makes
function CleanURL(const URL: String): String;
var
  x: Integer;
  p: String;
begin
  Result := Trim(URL);
  if Result = '' then Exit;
  if Pos(':', Result) = 1 then
    Delete(Result, 1, 1);
  if Pos('//', Result) = 1 then
    Delete(Result, 1, 2);
  p := '';
  x := Pos('://', Result);
  if x > 0 then
  begin
    x := x + 2;
    p := Copy(Result, 1, x);
    Delete(Result, 1, x);
    while Pos('/', Result) = 1 do
      Delete(Result, 1, 1);
  end;
  Result := ReplaceRegExpr('([^:])[\/]{2,}', Result, '$1/', True);
  Result := p + Result;
end;

// httpsendthread.pas:157 poschar
// (`s[i] in escapechars` of the original is expressed with Pos(): identical
// membership semantics, valid in {$mode objfpc})
function poschar(const c: char; const s: string; const offset: cardinal = 1;
  const escapechars: string = ''): integer;
var
  i: integer;
begin
  for i := Integer(offset) to length(s) do
  begin
    if Pos(s[i], escapechars) > 0 then Break;
    if s[i] = c then Exit(i);
  end;
  Result := 0;
end;

// httpsendthread.pas:191 — exact port (only APath is consumed by
// RemoveHostFromURL, but the whole algorithm is replicated so behavior —
// including host/port edge cases — matches byte-for-byte)
procedure SplitURL(const AURL: String; const AHost, APath: PString;
  const AIncludeProtocol: Boolean; const AIncludePort: Boolean);

procedure cleanuri(var u: string);
begin
  while (Length(u) <> 0) and (u[1] in ['.', ':', '/']) do
    Delete(u, 1, 1);
end;

var
  iurl, ihost, ipath, iproto, iport: String;
  p, q: Integer;
begin
  if (AHost = nil) and (APath = nil) then Exit;
  if Assigned(AHost) then AHost^ := '';
  if Assigned(APath) then APath^ := '';
  iurl := Trim(AURL);
  if iurl = '' then Exit;
  ihost := '';
  ipath := '';
  iproto := '';
  iport := '';
  if iurl[1] = '/' then
    if Length(iurl) = 1 then Exit
    else
    if iurl[2] <> '/' then
    begin
      if Assigned(APath) then APath^ := iurl;
      Exit;
    end;
  p := poschar(':', iurl, 1, '/');
  if (p <> 0) and (p + 2 < Length(iurl)) and (iurl[P + 1] + iurl[p + 2] = '//') then
  begin
    iproto := Copy(iurl, 1, p - 1);
    Delete(iurl, 1, p + 2);
    p := poschar(':', iurl, 1, '/');
  end;
  q := 0;
  if (p <> 0) and (p < Length(iurl)) and (iurl[P + 1] in ['0'..'9']) then
  begin
    for q := p + 1 to Length(iurl) do
      if not (iurl[q] in ['0'..'9']) then Break;
    if q = Length(iurl) then Inc(q);
    iport := Copy(iurl, p + 1, q - p - 1);
    delete(iurl, p, q - p);
  end;
  cleanuri(iurl);
  p := poschar('.', iurl, 1, '/');
  q := poschar('/', iurl);
  if (p <> 0) and (p < Length(iurl)) then
    if p < q then
    begin
      ihost := Copy(iurl, 1, q - 1);
      Delete(iurl, 1, q - 1);
      cleanuri(iurl);
    end
    else
    if q = 0 then
    begin
      q := poschar('.', iurl, p + 1);
      if (q <> 0) and (q < Length(iurl)) then
      begin
        ihost := iurl;
        iurl := '';
      end;
    end;
  if (ihost = '') and (iurl <> '') and ((iproto <> '') or (iport <> '')) then
  begin
    ihost := iurl;
    iurl := '';
  end;
  if ihost <> '' then
  begin
    if AIncludeProtocol then
    begin
      if iproto <> '' then ihost := iproto + '://' + ihost
      else ihost := 'https://' + ihost;
    end;
    if AIncludePort and (iport <> '') then
      ihost := ihost + ':' + iport;
  end;
  if iurl <> '' then
    ipath := '/' + iurl;
  if Assigned(AHost) then AHost^ := ihost;
  if Assigned(APath) then APath^ := ipath;
end;

// uBaseUnit.pas:969
function RemoveHostFromURL(URL: String): String;
begin
  SplitURL(URL, nil, @Result);
end;

// uBaseUnit.pas:983 — strips hosts pairwise; entries whose link reduces to
// '' are deleted from BOTH lists in place
procedure RemoveHostFromURLsPair(const URLs, Names: TStringList);
var
  i: Integer;
begin
  if (URLs = nil) or (Names = nil) or (URLs.Count <> Names.Count) or (URLs.Count = 0) then Exit;
  i := 0;
  while i < URLs.Count do
  begin
    URLs[i] := RemoveHostFromURL(URLs[i]);
    if URLs[i] <> '' then
      Inc(i)
    else
    begin
      URLs.Delete(i);
      Names.Delete(i);
    end;
  end;
end;

// uBaseUnit.pas:2793
function MangaInfoStatusIfPos(const SearchStr: String; const OngoingStr: String;
  const CompletedStr: String; const HiatusStr: String; const CancelledStr: String): String;
var
  s, o, c, h, ca: String;

  function searchMany(const t: String): Boolean;
  var
    i: String;
  begin
    if t = '' then
    begin
      Exit(False);
    end;

    if Pos('|', t) = 0 then
    begin
      Result := Pos(t, s) <> 0;
    end
    else
    begin
      for i in t.Split(['|']) do
      begin
        if Pos(i, s) <> 0 then
        begin
          Exit(True);
        end;
      end;
      Result := False
    end;
  end;

begin
  Result := '';
  if SearchStr = '' then Exit;
  s := LowerCase(SearchStr);
  o := LowerCase(OngoingStr);
  c := LowerCase(CompletedStr);
  h := LowerCase(HiatusStr);
  ca := LowerCase(CancelledStr);

  if searchMany(o) then
  begin
    Result := MangaInfo_StatusOngoing
  end
  else if searchMany(c) then
  begin
    Result := MangaInfo_StatusCompleted
  end
  else if searchMany(h) then
  begin
    Result := MangaInfo_StatusHiatus
  end
  else if searchMany(ca) then
  begin
    Result := MangaInfo_StatusCancelled
  end
  else
  begin
    Result := MangaInfo_StatusUnknown
  end;
end;

end.
