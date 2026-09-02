-- Sourced at startup even when the plugin is lazy-loaded, so .pj buffers get the filetype
-- that triggers loading the rest of the plugin.
vim.filetype.add { extension = { pj = "processj" } }
