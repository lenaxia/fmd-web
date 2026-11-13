-- Init-pass fixture: exercises the full options API (§5.1) incl. combobox
-- INDEX defaults, AccountSupport/Account, and the typed surface.
function Init()
	local m = NewWebsiteModule()
	m.ID                       = 'aaaa1111bbbb2222cccc3333dddd4444'
	m.Name                     = 'OptionsShowcase'
	m.RootURL                  = 'https://showcase.example'
	m.Category                 = 'English'
	m.AccountSupport           = true
	m.MaxTaskLimit             = 2
	m.MaxConnectionLimit       = 4
	m.SortedList               = true

	m.AddOptionCheckBox('dark_mode', 'Dark mode:', true)
	m.AddOptionEdit('session', 'Session ID:', 'abc123')
	m.AddOptionSpinEdit('concurrency', 'Concurrency:', 3)
	m.AddOptionComboBox('quality', 'Quality:', 'Low,Medium,High', 2)
	local a = m.Account
	a.Username = 'user'
end
