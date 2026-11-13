# fmd-web local CI gate — thin wrapper over scripts/ci.sh
.PHONY: ci test coverage lint typecheck build harness

ci:
	bash scripts/ci.sh

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
