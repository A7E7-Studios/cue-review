# Tasks: Run the speech runtime built for the processor's vector instructions

## 1. The runtime build

- [x] 1.1 Build the plain (SSE4.2, no BMI2) and, on Windows and Linux x64, the AVX2/FMA/F16C/BMI2 runtime into `avx2/`; test: node scripts/build-speech-runtime.mjs
- [x] 1.2 Check both builds in the packaged installers; test: node scripts/verify-bundle.mjs (CI's installer build)
- [x] 1.3 Update README.md to say the runtime folder holds the AVX2 build in `avx2/`; test: node tools/gate/gate.mjs --local

## 2. Choosing the build and the threads (after 1)

- [x] 2.1 Run the `avx2` build where the processor has AVX2, FMA, F16C and BMI2; test: src-tauri/src/deps.rs::tests::the_vector_build_runs_where_the_processor_supports_it
- [x] 2.2 Keep the plain build elsewhere; test: src-tauri/src/deps.rs::tests::the_plain_build_runs_where_the_vector_build_cannot
- [x] 2.3 Thread counts for final and live transcription; test: src-tauri/src/transcribe.rs::tests::thread_counts_follow_the_processor
- [x] 2.4 The vector build is at least three times faster with the same words; test: src-tauri/src/transcribe.rs::tests::actual_vector_build_is_faster_than_the_plain_build
- [x] 2.5 Five minutes of speech transcribed in the installed app; check: Five minutes of speech is transcribed in seconds
- [x] 2.6 Update README.md (the runtime folder and its `avx2/` build, which `deps::tool` picks), docs/ARCHITECTURE.md and docs/VERIFICATION.md; test: node tools/gate/gate.mjs --local
