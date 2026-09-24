/* SPDX-License-Identifier: Apache-2.0
 * Copyright (c) 2026 TaskWraith contributors
 */

#include <emscripten/emscripten.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <libretro.h>

#ifndef TWEMU_ROM_PATH
#error TWEMU_ROM_PATH must name the reviewed embedded ROM path
#endif
#define TWEMU_MAX_WIDTH 256
#define TWEMU_MAX_HEIGHT 224
#define TWEMU_MAX_ROM_BYTES (8u * 1024u * 1024u)

static uint32_t twemu_framebuffer[TWEMU_MAX_WIDTH * TWEMU_MAX_HEIGHT];
static unsigned twemu_width;
static unsigned twemu_height;
static uint32_t twemu_frame_count;
static uint16_t twemu_buttons;
static int twemu_core_initialized;
static int twemu_initialized;
static void *twemu_rom_bytes;

#define TWEMU_JOYPAD_MASK \
  ((1u << RETRO_DEVICE_ID_JOYPAD_B) | (1u << RETRO_DEVICE_ID_JOYPAD_SELECT) | \
   (1u << RETRO_DEVICE_ID_JOYPAD_START) | (1u << RETRO_DEVICE_ID_JOYPAD_UP) | \
   (1u << RETRO_DEVICE_ID_JOYPAD_DOWN) | (1u << RETRO_DEVICE_ID_JOYPAD_LEFT) | \
   (1u << RETRO_DEVICE_ID_JOYPAD_RIGHT) | (1u << RETRO_DEVICE_ID_JOYPAD_A))

static void twemu_log(enum retro_log_level level, const char *format, ...)
{
  (void)level;
  (void)format;
}

static bool twemu_environment(unsigned command, void *data)
{
  switch (command) {
    case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
      *(const char **)data = "/";
      return true;
    case RETRO_ENVIRONMENT_GET_LOG_INTERFACE: {
      struct retro_log_callback *callback = data;
      callback->log = twemu_log;
      return true;
    }
    case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
      return true;
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
      return *(enum retro_pixel_format *)data == RETRO_PIXEL_FORMAT_XRGB8888;
    case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
      *(bool *)data = false;
      return true;
    case RETRO_ENVIRONMENT_GET_VARIABLE:
      return false;
    case RETRO_ENVIRONMENT_SET_GEOMETRY:
    case RETRO_ENVIRONMENT_SET_SUPPORT_ACHIEVEMENTS:
    case RETRO_ENVIRONMENT_SET_SUBSYSTEM_INFO:
    case RETRO_ENVIRONMENT_SET_MEMORY_MAPS:
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2:
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2_INTL:
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS:
      return true;
    default:
      return false;
  }
}

static void twemu_video_refresh(const void *data, unsigned width, unsigned height, size_t pitch)
{
  if (
    !data ||
    width == 0 ||
    height == 0 ||
    width > TWEMU_MAX_WIDTH ||
    height > TWEMU_MAX_HEIGHT ||
    pitch < width * sizeof(uint32_t)
  ) {
    return;
  }
  const uint8_t *source = data;
  for (unsigned row = 0; row < height; row++) {
    memcpy(
      twemu_framebuffer + row * width,
      source + row * pitch,
      width * sizeof(uint32_t)
    );
  }
  twemu_width = width;
  twemu_height = height;
  twemu_frame_count += 1;
}

static size_t twemu_audio_batch(const int16_t *data, size_t frames)
{
  (void)data;
  return frames;
}

static void twemu_audio_sample(int16_t left, int16_t right)
{
  (void)left;
  (void)right;
}

static void twemu_input_poll(void)
{
}

static int16_t twemu_input_state(unsigned port, unsigned device, unsigned index, unsigned id)
{
  (void)index;
  if (port != 0 || device != RETRO_DEVICE_JOYPAD) return 0;
  if (id == RETRO_DEVICE_ID_JOYPAD_MASK) return (int16_t)twemu_buttons;
  if (id > RETRO_DEVICE_ID_JOYPAD_R3) return 0;
  return (twemu_buttons & (uint16_t)(1u << id)) ? 1 : 0;
}

static int twemu_load_fixed_rom(void)
{
  FILE *file = fopen(TWEMU_ROM_PATH, "rb");
  if (!file) return 0;
  if (fseek(file, 0, SEEK_END) != 0) {
    fclose(file);
    return 0;
  }
  long byte_count = ftell(file);
  if (
    byte_count <= 0 ||
    byte_count > (long)TWEMU_MAX_ROM_BYTES ||
    fseek(file, 0, SEEK_SET) != 0
  ) {
    fclose(file);
    return 0;
  }
  twemu_rom_bytes = malloc((size_t)byte_count);
  if (!twemu_rom_bytes) {
    fclose(file);
    return 0;
  }
  const size_t read = fread(twemu_rom_bytes, 1, (size_t)byte_count, file);
  fclose(file);
  if (read != (size_t)byte_count) {
    free(twemu_rom_bytes);
    twemu_rom_bytes = NULL;
    return 0;
  }
  const struct retro_game_info info = {
    .path = TWEMU_ROM_PATH,
    .data = twemu_rom_bytes,
    .size = (size_t)byte_count,
    .meta = NULL
  };
  const bool loaded = retro_load_game(&info);
  if (!loaded) {
    free(twemu_rom_bytes);
    twemu_rom_bytes = NULL;
    return 0;
  }
  return 1;
}

EMSCRIPTEN_KEEPALIVE int twemu_initialize(void)
{
  if (twemu_initialized) return 1;
  retro_set_environment(twemu_environment);
  retro_set_video_refresh(twemu_video_refresh);
  retro_set_audio_sample(twemu_audio_sample);
  retro_set_audio_sample_batch(twemu_audio_batch);
  retro_set_input_poll(twemu_input_poll);
  retro_set_input_state(twemu_input_state);
  retro_init();
  twemu_core_initialized = 1;
  if (!twemu_load_fixed_rom()) {
    retro_deinit();
    twemu_core_initialized = 0;
    return 0;
  }
  retro_set_controller_port_device(0, RETRO_DEVICE_JOYPAD);
  twemu_initialized = 1;
  return 1;
}

EMSCRIPTEN_KEEPALIVE int twemu_step(uint32_t buttons, uint32_t frames)
{
  /* Product JavaScript invokes exactly one frame, then yields back to the
   * browser event loop. It must not synchronously monopolize a live dock. */
  if (!twemu_initialized || frames != 1) return 0;
  twemu_buttons = (uint16_t)(buttons & TWEMU_JOYPAD_MASK);
  retro_run();
  twemu_buttons = 0;
  return 1;
}

EMSCRIPTEN_KEEPALIVE void twemu_shutdown(void)
{
  if (!twemu_initialized) return;
  retro_unload_game();
  if (twemu_core_initialized) retro_deinit();
  free(twemu_rom_bytes);
  twemu_rom_bytes = NULL;
  twemu_initialized = 0;
  twemu_core_initialized = 0;
  twemu_buttons = 0;
  twemu_width = 0;
  twemu_height = 0;
  twemu_frame_count = 0;
}

EMSCRIPTEN_KEEPALIVE uintptr_t twemu_framebuffer_ptr(void)
{
  return (uintptr_t)twemu_framebuffer;
}

EMSCRIPTEN_KEEPALIVE unsigned twemu_framebuffer_width(void)
{
  return twemu_width;
}

EMSCRIPTEN_KEEPALIVE unsigned twemu_framebuffer_height(void)
{
  return twemu_height;
}

EMSCRIPTEN_KEEPALIVE uint32_t twemu_frames_presented(void)
{
  return twemu_frame_count;
}

EMSCRIPTEN_KEEPALIVE uintptr_t twemu_system_ram_ptr(void)
{
  if (!twemu_initialized) return 0;
  return (uintptr_t)retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM);
}

EMSCRIPTEN_KEEPALIVE size_t twemu_system_ram_size(void)
{
  if (!twemu_initialized) return 0;
  return retro_get_memory_size(RETRO_MEMORY_SYSTEM_RAM);
}

int main(void)
{
  return twemu_initialize() ? 0 : 1;
}
