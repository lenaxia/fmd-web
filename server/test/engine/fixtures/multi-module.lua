-- Init-pass fixture: one file registering MULTIPLE modules (§5.1).
function Init()
	local first = NewWebsiteModule()
	first.ID                   = '11112222333344445555666677778888'
	first.Name                 = 'MultiFirst'
	first.RootURL              = 'https://first.example'

	local second = NewWebsiteModule()
	second.ID                  = '88887777666655554444333322221111'
	second.Name                = 'MultiSecond'
	second.RootURL             = 'https://second.example'
	second.Category            = 'Raw'
	second.OnGetInfo           = 'GetInfo'
end
