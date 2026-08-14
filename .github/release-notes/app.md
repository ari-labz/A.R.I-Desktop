Changes since v0.3.0:

- search_files no longer reads binary or archive files (zip, dll, exe, images, etc.) — previously a regex search could pull thousands of characters of garbage from build zips into context
- read_file now rejects files over 24 KB before reading, returning a clear message instead of dumping the whole file into context
