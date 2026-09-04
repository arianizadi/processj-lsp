" Vim syntax for generated ProcessJ analysis reports (.pjreport).
" Keep a distinct filetype so editor Markdown Tree-sitter plugins do not attach,
" while retaining lightweight Markdown highlighting through Vim syntax.
if exists("b:current_syntax")
  finish
endif

runtime! syntax/markdown.vim
let b:current_syntax = "processjreport"
