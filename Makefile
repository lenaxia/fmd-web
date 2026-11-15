# fmd-web local CI gate — thin wrapper over scripts/ci.sh
.PHONY: ci test coverage lint typecheck build harness e2e

ci:
	bash scripts/ci.sh

e2e:
	bash scripts/e2e.sh

test:
	npm test

coverage:
	npm run test:coverage

lint:
	npm run lint

typecheck:
	npm run typecheck

build:
	npm run build

harness:
	bash corpus/harness/build.sh
