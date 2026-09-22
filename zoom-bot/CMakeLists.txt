cmake_minimum_required(VERSION 3.16)
project(zoomer_bot CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Path to the extracted Zoom Meeting SDK (headers in h/, libmeetingsdk.so, qt_libs/).
set(ZOOM_SDK_DIR "/home/ubuntu/zoom-meeting-sdk" CACHE PATH "Zoom Meeting SDK directory")

find_package(OpenSSL REQUIRED)          # jwt HMAC (libssl-dev)
find_package(CURL REQUIRED)             # ingest HTTP (libcurl4-openssl-dev)
find_package(nlohmann_json REQUIRED)    # JSON wire (nlohmann-json3-dev)
find_library(TURBOJPEG_LIB turbojpeg REQUIRED)   # I420->JPEG (libturbojpeg0-dev)
find_path(TURBOJPEG_INC turbojpeg.h REQUIRED)

add_executable(zoomer-bot src/main.cpp)
target_include_directories(zoomer-bot PRIVATE
  ${CMAKE_SOURCE_DIR}/src
  ${ZOOM_SDK_DIR}/h
  ${TURBOJPEG_INC})
target_link_directories(zoomer-bot PRIVATE ${ZOOM_SDK_DIR})
target_link_libraries(zoomer-bot PRIVATE
  meetingsdk                # libmeetingsdk.so
  OpenSSL::Crypto
  CURL::libcurl
  nlohmann_json::nlohmann_json
  ${TURBOJPEG_LIB}
  pthread)
# Resolve libmeetingsdk.so and its bundled Qt at runtime.
set_target_properties(zoomer-bot PROPERTIES
  BUILD_RPATH "${ZOOM_SDK_DIR};${ZOOM_SDK_DIR}/qt_libs")

# Standalone syntax check of the non-SDK helpers (no Zoom SDK needed):
#   cmake --build build --target helpers_check
add_executable(helpers_check EXCLUDE_FROM_ALL tests/helpers_check.cpp)
target_include_directories(helpers_check PRIVATE ${CMAKE_SOURCE_DIR}/src ${TURBOJPEG_INC})
target_link_libraries(helpers_check PRIVATE OpenSSL::Crypto CURL::libcurl nlohmann_json::nlohmann_json ${TURBOJPEG_LIB} pthread)
