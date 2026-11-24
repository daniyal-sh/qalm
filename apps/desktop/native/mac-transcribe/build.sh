#!/bin/sh
# Builds the lecture-mode speech helper on macOS 13+ (universal binary). Run before `pnpm --filter @qalm/desktop dist`.
set -e
cd "$(dirname "$0")"
mkdir -p build
swiftc -O -target arm64-apple-macos13 -o build/mac-transcribe-arm64 main.swift
swiftc -O -target x86_64-apple-macos13 -o build/mac-transcribe-x64 main.swift
lipo -create -output build/mac-transcribe build/mac-transcribe-arm64 build/mac-transcribe-x64
rm build/mac-transcribe-arm64 build/mac-transcribe-x64
echo "built build/mac-transcribe"
