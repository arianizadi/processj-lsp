-- Sourced at startup even when the plugin is lazy-loaded, so .pj buffers get the filetype
-- that triggers loading the rest of the plugin.
vim.filetype.add {
  extension = {
    pj = "processj",
    -- Analysis reports contain Markdown, but using the ordinary markdown
    -- filetype activates third-party Tree-sitter integrations that can crash
    -- while an LSP-created report buffer is being loaded or refreshed.
    pjreport = "processjreport",
  },
}
