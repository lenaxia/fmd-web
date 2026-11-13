// fmdnormalize.pas — exact replication of TMangaInformation.GetInfoFromURL
// post-processing (FMD2 uData.pas:85-207 @ 97c903b), operating on the raw
// module output of one manga-info fixture.
//
// Provenance & license: derived from FMD2 (https://github.com/dazedcat19/
// FMD2 — canonical home; formerly rombinary/fmd2) baseunits/uData.pas,
// which is GPLv2 ("This unit is a part of Free
// Manga Downloader"); this replication is therefore distributed under
// GPLv2 as well. String helpers used here come from fmdstrings.pas (same
// provenance).
//
// Deviations from a live FMD2 run (documented, deliberate):
//  1. GetBaseMangaInfo/FillBaseMangaInfo (uData.pas:95,140): a live run
//     snapshots MangaInfo BEFORE OnGetInfo and re-fills empty fields
//     afterwards. A fixture captures the state right AFTER OnGetInfo
//     returned, and the pre-call snapshot of a fresh TMangaInformation is
//     empty — so FillBaseMangaInfo is a provable no-op here and is omitted.
//  2. Field arrays (altTitles/authors/artists/genres): FMD2 Lua modules
//     build these with table.concat(t, ', ') before assigning to
//     TMangaInfo's single String fields. String-typed JSON values are taken
//     verbatim; arrays are joined with ', ' (the real module-output shape).
//  3. isRemoveHostFromChapterLinks defaults True (uData.pas:64 ctor);
//     OptionRemoveMangaNameFromChapter defaults False (FMDOptions.pas:168).
//
// Status is passed through untouched: uData.pas:85-207 never rewrites it.
unit fmdnormalize;

{$mode objfpc}{$H+}

interface

uses
  Classes, SysUtils, fpjson, fmdstrings;

type
  // flags mirroring the FMD2 globals that steer this code path
  TNormalizeFlags = record
    isRemoveHostFromChapterLinks: Boolean;      // uData ctor default True
    OptionRemoveMangaNameFromChapter: Boolean;  // FMDOptions default False
  end;

const
  DefaultNormalizeFlags: TNormalizeFlags = (
    isRemoveHostFromChapterLinks: True;
    OptionRemoveMangaNameFromChapter: False
  );

// Reads flags object (missing keys keep defaults).
function FlagsFromJSON(Obj: TJSONData): TNormalizeFlags;

// Reads one MangaInfo scalar field: string verbatim; array joined ', '
// (Lua table.concat semantics); null/missing → ''.
// NOTE: uses AsString (typed TJSONStringType), never .Value (Variant) —
// the Variant round-trip mangles non-ASCII UTF-8 bytes.
function ScalarField(Obj: TJSONObject; const Name: String): String;

// TStrings → TJSONArray of strings (caller owns the returned data).
function StringsToJSON(List: TStrings): TJSONArray;

// The uData.pas:85-207 pipeline (everything after OnGetInfo returned).
// Input/raw and Output/normalized are fpjson TJSONObjects; the normalized
// object is filled with the post-processed MangaInfo state.
procedure NormalizeMangaInfo(const Raw: TJSONObject; const Flags: TNormalizeFlags;
  Normalized: TJSONObject);

implementation

function FlagsFromJSON(Obj: TJSONData): TNormalizeFlags;
var
  O: TJSONObject;
begin
  Result := DefaultNormalizeFlags;
  if not (Obj is TJSONObject) then Exit;
  O := TJSONObject(Obj);
  if O.IndexOfName('removeHostFromChapterLinks') >= 0 then
    Result.isRemoveHostFromChapterLinks := O.Booleans['removeHostFromChapterLinks'];
  if O.IndexOfName('optionRemoveMangaNameFromChapter') >= 0 then
    Result.OptionRemoveMangaNameFromChapter := O.Booleans['optionRemoveMangaNameFromChapter'];
end;

function ScalarField(Obj: TJSONObject; const Name: String): String;
var
  D: TJSONData;
  I: Integer;
begin
  Result := '';
  if Obj = nil then Exit;
  D := Obj.FindPath(Name);
  if D = nil then Exit;
  if D is TJSONString then
    Result := TJSONString(D).AsString
  else if (D is TJSONArray) then
  begin
    for I := 0 to TJSONArray(D).Count - 1 do
    begin
      if I > 0 then Result += ', ';
      if TJSONArray(D)[I] is TJSONString then
        Result += TJSONString(TJSONArray(D)[I]).AsString
      else if not (TJSONArray(D)[I] is TJSONNull) then
        Result += TJSONArray(D)[I].AsJSON;
    end;
  end
  else if not (D is TJSONNull) then
    Result := D.AsJSON;
end;

function StringsToJSON(List: TStrings): TJSONArray;
var
  I: Integer;
begin
  Result := TJSONArray.Create;
  for I := 0 to List.Count - 1 do
    Result.Add(List[I]);
end;

procedure NormalizeMangaInfo(const Raw: TJSONObject; const Flags: TNormalizeFlags;
  Normalized: TJSONObject);
var
  URL, Title, AltTitles, Link, CoverLink, Authors, Artists, Genres, Status,
  Summary, s, s2: String;
  NumChapter: Integer;
  ChapterLinks, ChapterNames: TStringList;
  j, k: Integer;
  del: Boolean;

  function GetList(const AName: String): TStringList;
  var
    D: TJSONData;
    I: Integer;
  begin
    Result := TStringList.Create;
    D := Raw.FindPath(AName);
    if D is TJSONArray then
      for I := 0 to TJSONArray(D).Count - 1 do
      begin
        if TJSONArray(D)[I] is TJSONString then
          Result.Add(TJSONString(TJSONArray(D)[I]).AsString)
        else
          Result.Add('');
      end
    else if D is TJSONString then
    begin
      // single string: one entry per line, matching how module chapter
      // lists arrive pre-split by the caller
      Result.Text := TJSONString(D).Value;
    end;
  end;

begin
  URL := ScalarField(Raw, 'url');
  Title := ScalarField(Raw, 'title');
  AltTitles := ScalarField(Raw, 'altTitles');
  Link := ScalarField(Raw, 'link');
  CoverLink := ScalarField(Raw, 'coverLink');
  Authors := ScalarField(Raw, 'authors');
  Artists := ScalarField(Raw, 'artists');
  Genres := ScalarField(Raw, 'genres');
  Status := ScalarField(Raw, 'status');
  Summary := ScalarField(Raw, 'summary');
  ChapterLinks := GetList('chapterLinks');
  ChapterNames := GetList('chapterNames');
  try
    // uData.pas:111-113 — Link fallback from URL
    if Link = '' then
      Link := RemoveHostFromURL(URL);

    // uData.pas:115-127 — cleanup info
    CoverLink := CleanURL(CoverLink);
    Title := Trim(FixWhiteSpace(RemoveStringBreaks(CommonStringFilter(Title))));
    AltTitles := Trim(FixWhiteSpace(RemoveStringBreaks(CommonStringFilter(AltTitles))));
    Authors := Trim(FixWhiteSpace(RemoveStringBreaks(Trim(Authors))));
    Artists := Trim(FixWhiteSpace(RemoveStringBreaks(Trim(Artists))));
    Genres := Trim(FixWhiteSpace(RemoveStringBreaks(Trim(Genres))));

    Authors := TrimRightChar(Trim(FixWhiteSpace(Authors)), [',']);
    Artists := TrimRightChar(Trim(FixWhiteSpace(Artists)), [',']);
    Genres := TrimRightChar(Trim(FixWhiteSpace(Genres)), [',']);

    Summary := CleanMultilinedString(FixWhiteSpace(Summary));

    // uData.pas:129-139 — fix info
    if (LeftStr(Authors, 1) = '<') or (Authors = '-') or (Authors = ':') then
      Authors := '';
    if (LeftStr(Artists, 1) = '<') or (Artists = '-') or (Artists = ':') then
      Artists := '';
    if (Summary = '-') or (Summary = ':') then
      Summary := '';
    if Title = '' then
      Title := 'N/A';
    if (LeftStr(AltTitles, 1) = '<') or (AltTitles = '-') or (AltTitles = ':') then
      AltTitles := '';

    // uData.pas:142-152 — pad/prune chapter names to match links, then Trim
    if ChapterLinks.Count > 0 then begin
      while ChapterNames.Count < ChapterLinks.Count do
        ChapterNames.Add('');
      while ChapterLinks.Count < ChapterNames.Count do
        ChapterNames.Delete(ChapterNames.Count - 1);
      for j := 0 to ChapterLinks.Count - 1 do begin
        ChapterLinks[j] := Trim(ChapterLinks[j]);
        ChapterNames[j] := Trim(ChapterNames[j]);
      end;
    end;

    // uData.pas:154-173 — case-insensitive duplicate removal deleting the
    // EARLIER index j, so the LAST occurrence's link+name survives
    if ChapterLinks.Count > 0 then
    begin
      j := 0;
      while j < (ChapterLinks.Count - 1) do
      begin
        del := False;
        if (j + 1) < ChapterLinks.Count then
          for k := j + 1 to ChapterLinks.Count - 1 do
            if SameText(ChapterLinks[j], ChapterLinks[k]) then
            begin
              ChapterLinks.Delete(j);
              ChapterNames.Delete(j);
              del := True;
              Break;
            end;
        if not del then
          Inc(j);
      end;
    end;

    if ChapterLinks.Count > 0 then
    begin
      // uData.pas:175-179 — remove host from chapter links (pair)
      if Flags.isRemoveHostFromChapterLinks then
        RemoveHostFromURLsPair(ChapterLinks, ChapterNames);
      // uData.pas:180-183 — fixing chapter name
      for j := 0 to ChapterNames.Count - 1 do
        ChapterNames[j] := Trim(CleanString(RemoveStringBreaks(
          CommonStringFilter(ChapterNames[j]))));

      // uData.pas:185-202 — remove manga name from chapter
      if Flags.OptionRemoveMangaNameFromChapter and (Title <> '') then
      begin
        s := LowerCase(Title);
        j := Length(s);
        for k := 0 to ChapterNames.Count - 1 do begin
          s2 := LowerCase(ChapterNames[k]);
          if Length(s2) > j then
            if Pos(s, s2) = 1 then begin
              s2 := ChapterNames[k];
              Delete(s2, 1, j);
              s2 := Trim(s2);
              if LeftStr(s2, 2) = '- ' then
                Delete(s2, 1, 2);
              ChapterNames[k] := s2;
            end;
        end;
      end;
    end;

    // uData.pas:205
    NumChapter := ChapterLinks.Count;

    // emit
    Normalized.Add('title', Title);
    Normalized.Add('altTitles', AltTitles);
    Normalized.Add('authors', Authors);
    Normalized.Add('artists', Artists);
    Normalized.Add('genres', Genres);
    Normalized.Add('status', Status);
    Normalized.Add('summary', Summary);
    Normalized.Add('coverLink', CoverLink);
    Normalized.Add('url', URL);
    Normalized.Add('link', Link);
    Normalized.Add('chapterLinks', StringsToJSON(ChapterLinks));
    Normalized.Add('chapterNames', StringsToJSON(ChapterNames));
    Normalized.Add('numChapter', NumChapter);
  finally
    ChapterLinks.Free;
    ChapterNames.Free;
  end;
end;

end.
