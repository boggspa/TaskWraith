ifndef RGBDS
$(error RGBDS must name the directory containing RGBDS v1.0.3; use scripts/emulator/build-emulator-assets.cjs with an explicit local toolchain path)
endif

RGBASM := $(RGBDS)/rgbasm
RGBLINK := $(RGBDS)/rgblink
RGBFIX := $(RGBDS)/rgbfix
RGBDS_VERSION := 1.0.3

ROM := taskwraith-fixture.gb
OBJ := build/main.o

.PHONY: all clean check-toolchain

all: check-toolchain $(ROM)

check-toolchain:
	@test "$$($(RGBASM) -V)" = "rgbasm v$(RGBDS_VERSION)"
	@test "$$($(RGBLINK) -V)" = "rgblink v$(RGBDS_VERSION)"
	@test "$$($(RGBFIX) -V)" = "rgbfix v$(RGBDS_VERSION)"

$(OBJ): src/main.asm src/hardware.inc
	mkdir -p build
	$(RGBASM) -I src -o $@ src/main.asm

$(ROM): $(OBJ)
	$(RGBLINK) -m build/taskwraith-fixture.map -n build/taskwraith-fixture.sym -o $@ $<
	# Deliberately do not inject Nintendo's boot-logo bytes. SameBoy's open
	# boot ROM accepts non-Nintendo logos, which keeps this emulator-only test
	# fixture wholly first-party.
	$(RGBFIX) -f hg -p 0 -t "TW EMU FIXTURE" $@

clean:
	rm -rf build $(ROM)
