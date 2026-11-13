# corpus/harness Makefile — ground-truth capture harness (D1)
#
#   make harness         build bin/fmd_capture (pinned toolchain, selftest gate)
#   make selftest        build + run the helper/normalization unit tests
#   make verify-tables   byte-verify the replicated uBaseUnit tables
#                        against the FMD2 originals (needs python3)
#   make clean           remove build outputs; purge any stray FPC
#                        artifacts from vendor/ (pinned sources stay)
#
# The real logic lives in build.sh; this file is the stable entry point
# wired into the repo-root Makefile (`make harness`).

.PHONY: harness selftest verify-tables clean

harness:
	bash build.sh

selftest:
	bash build.sh && ./bin/fmd_capture selftest

verify-tables:
	python3 tools/verify-tables.py

clean:
	rm -rf bin
	find vendor -type f \( -name '*.ppu' -o -name '*.o' -o -name '*.rsj' \) -delete
