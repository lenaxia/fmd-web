-- e2eutil — non-module support file for the fixture lua tree: proves
-- the sync stages the whole lua/ subtree (templates/utils included),
-- not only modules/*.lua (staged-tree validation compile-checks it).
local e2eutil = {}

function e2eutil.greeting()
	return 'fmd-web e2e fixture tree'
end

return e2eutil
