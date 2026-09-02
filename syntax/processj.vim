" Vim syntax file for ProcessJ (.pj)
if exists("b:current_syntax")
  finish
endif

syn keyword pjStatement   break continue return skip stop suspend resume sync claim fork seq with
syn keyword pjConditional if else switch case default
syn keyword pjRepeat      while for do
syn keyword pjConcurrent  par alt pri enroll
syn keyword pjStorage     const shared mobile native extern
syn keyword pjAccess      public private protected
syn keyword pjStructure   record protocol extends implements proc
syn keyword pjType        boolean byte char short int long float double string void chan timer barrier
syn keyword pjOperator    new is read write timeout
syn keyword pjBoolean     true false null
syn keyword pjImport      import package

syn match   pjPragma      "^\s*#pragma.*$"
syn match   pjNumber      "\<\d\+\(\.\d\+\)\=\([eE][+-]\=\d\+\)\=[lLfFdD]\=\>"
syn match   pjNumber      "\<0[xX]\x\+[lL]\=\>"
syn region  pjString      start=+"+ skip=+\\"+ end=+"+ oneline
syn region  pjChar        start=+'+ skip=+\\'+ end=+'+ oneline
syn match   pjChanEnd     "\.\(read\|write\)\>"
syn match   pjProcCall    "\<\h\w*\ze\s*("

syn keyword pjTodo        contained TODO FIXME XXX NOTE
syn match   pjLineComment "//.*$" contains=pjTodo
syn region  pjBlockComment start="/\*" end="\*/" contains=pjTodo

hi def link pjStatement    Statement
hi def link pjConditional  Conditional
hi def link pjRepeat       Repeat
hi def link pjConcurrent   Special
hi def link pjStorage      StorageClass
hi def link pjAccess       StorageClass
hi def link pjStructure    Structure
hi def link pjType         Type
hi def link pjOperator     Operator
hi def link pjBoolean      Boolean
hi def link pjImport       Include
hi def link pjPragma       PreProc
hi def link pjNumber       Number
hi def link pjString       String
hi def link pjChar         Character
hi def link pjChanEnd      Identifier
hi def link pjProcCall     Function
hi def link pjTodo         Todo
hi def link pjLineComment  Comment
hi def link pjBlockComment Comment

let b:current_syntax = "processj"
