; SPDX-License-Identifier: MIT
; Copyright (c) 2026 TaskWraith contributors
;
; Original Game Boy fixture used to exercise the TaskWraith Emulator Canvas.
; It contains no Nintendo code, assets, or ROM data.

INCLUDE "hardware.inc"

; Public, active-high input mask written to wLastInput.
DEF INPUT_A      EQU 1 << 0
DEF INPUT_B      EQU 1 << 1
DEF INPUT_SELECT EQU 1 << 2
DEF INPUT_START  EQU 1 << 3
DEF INPUT_RIGHT  EQU 1 << 4
DEF INPUT_LEFT   EQU 1 << 5
DEF INPUT_UP     EQU 1 << 6
DEF INPUT_DOWN   EQU 1 << 7

; Stable, versioned observability contract. The frame counter is little-endian.
; $C100..$C103 = ASCII "TWGB"; $C104 = ABI version; $C105 = status.
DEF ABI_MAGIC_T       EQU 'T'
DEF ABI_MAGIC_W       EQU 'W'
DEF ABI_MAGIC_G       EQU 'G'
DEF ABI_MAGIC_B       EQU 'B'
DEF ABI_SCHEMA_VERSION EQU 1
DEF ABI_STATUS_READY  EQU 1 << 0
DEF ABI_STATUS_PASS   EQU 1 << 1
DEF ABI_STATUS_FAIL   EQU 1 << 7

DEF WRAM_ABI_MAGIC      EQU $C100
DEF WRAM_ABI_VERSION    EQU $C104
DEF WRAM_ABI_STATUS     EQU $C105
DEF WRAM_X              EQU $C106
DEF WRAM_Y              EQU $C107
DEF WRAM_LAST_INPUT     EQU $C108
DEF WRAM_FRAME_COUNTER  EQU $C109

SECTION "RST00", ROM0[$0000]
    reti

SECTION "VBlank", ROM0[$0040]
    reti

SECTION "Entry", ROM0[$0100]
    nop
    jp Start
    ; Keep executable code out of the cartridge-header range $0104..$014F.
    ; This fixture leaves the Nintendo-logo bytes in that range omitted.
    ds $0150 - @, 0

SECTION "Fixture WRAM", WRAM0[$C100]
wAbiMagic::       ds 4
wAbiVersion::     db
wAbiStatus::      db
wX::              db
wY::              db
wLastInput::      db
wFrameCounter::   ds 4

SECTION "Main", ROM0
Start:
    di
    ; The boot ROM normally leaves LCD on. Wait for VBlank before disabling it.
    call WaitVBlank
    xor a
    ldh [rLCDC], a

    ; Neutral palettes: color 0 is white and color 3 is black.
    ld a, %11100100
    ldh [rBGP], a
    ldh [rOBP0], a

    ; Tile 0 is blank; tile 1 is a solid 8x8 square.
    ld hl, $8000
    ld de, TileData
    ld bc, TileDataEnd - TileData
    call MemCopy

    ; Clear OAM while the LCD is off.
    ld hl, $FE00
    ld bc, 160
    xor a
.clearOAM:
    ld [hli], a
    dec bc
    ld a, b
    or c
    jr nz, .clearOAM

    ; Publish the ABI before the state values. Readers wait for the ready/pass
    ; status after checking this fixed magic and version.
    ld a, ABI_MAGIC_T
    ld [wAbiMagic], a
    ld a, ABI_MAGIC_W
    ld [wAbiMagic + 1], a
    ld a, ABI_MAGIC_G
    ld [wAbiMagic + 2], a
    ld a, ABI_MAGIC_B
    ld [wAbiMagic + 3], a
    ld a, ABI_SCHEMA_VERSION
    ld [wAbiVersion], a
    xor a
    ld [wAbiStatus], a

    ; The coordinate contract is screen-space pixel coordinates, not OAM's
    ; hardware-offset form. The OAM writer adds the documented +8/+16 offsets.
    ld a, 80
    ld [wX], a
    ld a, 72
    ld [wY], a
    xor a
    ld [wLastInput], a
    ld [wFrameCounter], a
    ld [wFrameCounter + 1], a
    ld [wFrameCounter + 2], a
    ld [wFrameCounter + 3], a
    call WriteSprite
    call ValidateAbi
    jr c, .abiFailed
    ld a, ABI_STATUS_READY | ABI_STATUS_PASS
    ld [wAbiStatus], a

    ; Background and sprites, 8x8 sprites, unsigned tiles at $8000.
    ld a, %10010011
    ldh [rLCDC], a

.frame:
    call WaitVBlank
    call ReadJoypad
    ld [wLastInput], a
    call ApplyInput
    call IncrementFrameCounter
    call WriteSprite
    jr .frame

.abiFailed:
    ld a, ABI_STATUS_FAIL
    ld [wAbiStatus], a
.halt:
    halt
    jr .halt

; A deterministic first-frame self-test. PASS means the static ABI identity,
; version, and zeroed initial fields all matched before the main loop starts.
; Carry set = fail; carry clear = pass.
ValidateAbi:
    ld a, [wAbiMagic]
    cp ABI_MAGIC_T
    jr nz, .fail
    ld a, [wAbiMagic + 1]
    cp ABI_MAGIC_W
    jr nz, .fail
    ld a, [wAbiMagic + 2]
    cp ABI_MAGIC_G
    jr nz, .fail
    ld a, [wAbiMagic + 3]
    cp ABI_MAGIC_B
    jr nz, .fail
    ld a, [wAbiVersion]
    cp ABI_SCHEMA_VERSION
    jr nz, .fail
    ld a, [wX]
    cp 80
    jr nz, .fail
    ld a, [wY]
    cp 72
    jr nz, .fail
    ld a, [wLastInput]
    and a
    jr nz, .fail
    ld hl, wFrameCounter
    xor a
    or [hl]
    inc hl
    or [hl]
    inc hl
    or [hl]
    inc hl
    or [hl]
    jr nz, .fail
    and a
    ret
.fail:
    scf
    ret

; Wait for the NEXT VBlank edge. No interrupts are required. Merely waiting
; for LY >= 144 would run the main loop repeatedly during a single VBlank.
WaitVBlank:
 .waitForVisible:
    ldh a, [rLY]
    cp 144
    jr nc, .waitForVisible
.waitForVBlank:
    ldh a, [rLY]
    cp 144
    jr c, .waitForVBlank
    ret

; Read joypad once per frame. Returns the documented active-high mask in A.
; Direction bits are 4..7; button bits are 0..3.
ReadJoypad:
    ld a, P1F_GET_DPAD
    ldh [rP1], a
    ldh a, [rP1]
    ldh a, [rP1]
    cpl
    and $0F
    swap a
    ld b, a

    ld a, P1F_GET_BTN
    ldh [rP1], a
    ldh a, [rP1]
    ldh a, [rP1]
    cpl
    and $0F
    or b
    ld b, a

    ld a, P1F_GET_NONE
    ldh [rP1], a
    ld a, b
    ret

; Every held direction moves the square one screen pixel per emulated frame.
; A resets it to the deterministic start coordinate. Values deliberately use
; uint8 wraparound; test scenarios keep the fixture on-screen.
ApplyInput:
    bit 4, a
    jr z, .noRight
    ld hl, wX
    inc [hl]
.noRight:
    bit 5, a
    jr z, .noLeft
    ld hl, wX
    dec [hl]
.noLeft:
    bit 6, a
    jr z, .noUp
    ld hl, wY
    dec [hl]
.noUp:
    bit 7, a
    jr z, .noDown
    ld hl, wY
    inc [hl]
.noDown:
    bit 0, a
    ret z
    ld a, 80
    ld [wX], a
    ld a, 72
    ld [wY], a
    ret

IncrementFrameCounter:
    ld hl, wFrameCounter
    inc [hl]
    ret nz
    inc hl
    inc [hl]
    ret nz
    inc hl
    inc [hl]
    ret nz
    inc hl
    inc [hl]
    ret

; Copy the visible state to OAM entry 0.
WriteSprite:
    ld a, [wY]
    add a, 16
    ld [$FE00], a
    ld a, [wX]
    add a, 8
    ld [$FE01], a
    ld a, 1
    ld [$FE02], a
    xor a
    ld [$FE03], a
    ret

; BC bytes from DE to HL.
MemCopy:
    ld a, [de]
    inc de
    ld [hli], a
    dec bc
    ld a, b
    or c
    jr nz, MemCopy
    ret

TileData:
    ; Tile 0: blank background.
    REPT 16
        db 0
    ENDR
    ; Tile 1: a solid black square that visibly moves.
    REPT 8
        db $FF, $FF
    ENDR
TileDataEnd:
