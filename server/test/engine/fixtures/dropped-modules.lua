-- Init-pass fixture: registrations missing ID or Name are dropped
-- (LuaWebsiteModules.pas:523-533); the valid one survives.
function Init()
	local noId = NewWebsiteModule()
	noId.Name                  = 'MissingID'
	noId.RootURL               = 'https://noid.example'

	local noName = NewWebsiteModule()
	noName.ID                  = 'abcdabcdabcdabcdabcdabcdabcdabcd'
	noName.RootURL             = 'https://noname.example'

	local valid = NewWebsiteModule()
	valid.ID                   = 'ddddeeeeffff00001111222233334444'
	valid.Name                 = 'DropSurvivor'
	valid.RootURL              = 'https://valid.example'
end
