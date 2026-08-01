#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <vector>

#include "hb.h"
#include "hb-subset.h"
#include "woff2/decode.h"
#include "woff2/encode.h"

namespace {

enum SubsetStatus : int {
  kSubsetOk = 0,
  kSubsetInvalidInput = 1,
  kSubsetDecodeFailed = 2,
  kSubsetHarfBuzzFailed = 3,
  kSubsetEncodeFailed = 4,
  kSubsetAllocationFailed = 5,
  kSubsetOutputValidationFailed = 6,
};

bool IsWoff2(const uint8_t* bytes, size_t length) {
  return bytes != nullptr && length >= 4 && bytes[0] == 'w' &&
         bytes[1] == 'O' && bytes[2] == 'F' && bytes[3] == '2';
}

}  // namespace

extern "C" {

__attribute__((used)) int debrute_subset_woff2(
    const uint8_t* input,
    uint32_t input_length,
    const uint32_t* codepoints,
    uint32_t codepoint_count,
    uint8_t** output,
    uint32_t* output_length) {
  if (!IsWoff2(input, input_length) || codepoints == nullptr ||
      codepoint_count == 0 || output == nullptr || output_length == nullptr) {
    return kSubsetInvalidInput;
  }
  *output = nullptr;
  *output_length = 0;

  const size_t sfnt_size = woff2::ComputeWOFF2FinalSize(input, input_length);
  if (sfnt_size == 0 || sfnt_size > std::numeric_limits<unsigned int>::max()) {
    return kSubsetDecodeFailed;
  }
  std::vector<uint8_t> sfnt(sfnt_size);
  if (!woff2::ConvertWOFF2ToTTF(
          sfnt.data(), sfnt.size(), input, input_length)) {
    return kSubsetDecodeFailed;
  }

  hb_blob_t* source_blob = hb_blob_create(
      reinterpret_cast<const char*>(sfnt.data()),
      static_cast<unsigned int>(sfnt.size()),
      HB_MEMORY_MODE_READONLY,
      nullptr,
      nullptr);
  if (source_blob == hb_blob_get_empty()) {
    return kSubsetHarfBuzzFailed;
  }
  hb_face_t* source_face = hb_face_create(source_blob, 0);
  hb_blob_destroy(source_blob);
  if (source_face == hb_face_get_empty()) {
    hb_face_destroy(source_face);
    return kSubsetHarfBuzzFailed;
  }

  hb_subset_input_t* subset_input = hb_subset_input_create_or_fail();
  if (subset_input == nullptr) {
    hb_face_destroy(source_face);
    return kSubsetHarfBuzzFailed;
  }
  hb_subset_input_keep_everything(subset_input);
  hb_set_clear(hb_subset_input_glyph_set(subset_input));
  hb_set_t* unicode_set = hb_subset_input_unicode_set(subset_input);
  hb_set_clear(unicode_set);
  for (uint32_t index = 0; index < codepoint_count; ++index) {
    if (codepoints[index] > 0x10FFFFu) {
      hb_subset_input_destroy(subset_input);
      hb_face_destroy(source_face);
      return kSubsetInvalidInput;
    }
    hb_set_add(unicode_set, codepoints[index]);
  }

  hb_face_t* subset_face = hb_subset_or_fail(source_face, subset_input);
  hb_subset_input_destroy(subset_input);
  hb_face_destroy(source_face);
  if (subset_face == nullptr || subset_face == hb_face_get_empty()) {
    if (subset_face != nullptr) {
      hb_face_destroy(subset_face);
    }
    return kSubsetHarfBuzzFailed;
  }

  hb_blob_t* subset_blob = hb_face_reference_blob(subset_face);
  hb_face_destroy(subset_face);
  unsigned int subset_length = 0;
  const char* subset_data = hb_blob_get_data(subset_blob, &subset_length);
  if (subset_data == nullptr || subset_length == 0) {
    hb_blob_destroy(subset_blob);
    return kSubsetHarfBuzzFailed;
  }

  const auto* subset_bytes = reinterpret_cast<const uint8_t*>(subset_data);
  size_t compressed_length = woff2::MaxWOFF2CompressedSize(
      subset_bytes, subset_length);
  if (compressed_length == 0 ||
      compressed_length > std::numeric_limits<uint32_t>::max()) {
    hb_blob_destroy(subset_blob);
    return kSubsetEncodeFailed;
  }
  std::vector<uint8_t> compressed(compressed_length);
  woff2::WOFF2Params params;
  params.brotli_quality = 9;
  params.allow_transforms = true;
  if (!woff2::ConvertTTFToWOFF2(
          subset_bytes,
          subset_length,
          compressed.data(),
          &compressed_length,
          params)) {
    hb_blob_destroy(subset_blob);
    return kSubsetEncodeFailed;
  }
  hb_blob_destroy(subset_blob);

  if (!IsWoff2(compressed.data(), compressed_length) ||
      woff2::ComputeWOFF2FinalSize(compressed.data(), compressed_length) == 0) {
    return kSubsetOutputValidationFailed;
  }

  auto* result = static_cast<uint8_t*>(std::malloc(compressed_length));
  if (result == nullptr) {
    return kSubsetAllocationFailed;
  }
  std::memcpy(result, compressed.data(), compressed_length);
  *output = result;
  *output_length = static_cast<uint32_t>(compressed_length);
  return kSubsetOk;
}

__attribute__((used)) void debrute_subset_free(void* pointer) {
  std::free(pointer);
}

__attribute__((used)) uint32_t debrute_subset_contract_version() {
  return 1;
}

}  // extern "C"
