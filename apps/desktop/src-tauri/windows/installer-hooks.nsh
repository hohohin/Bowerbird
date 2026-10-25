; Tauri sets UpdateMode for application updates: preserve the existing login.
; Ordinary installs/reinstalls still reset; an interrupted reset keeps its marker.
!ifndef BOWERBIRD_AUTH_DATA
  !define BOWERBIRD_AUTH_DATA "$APPDATA\${BUNDLEID}"
!endif
LangString BowerbirdResetPrepareError 1033 "Cannot prepare Bowerbird login reset. Please retry installation."
LangString BowerbirdResetPrepareError 2052 "无法准备重置 Bowerbird 登录状态，请重新安装。"
LangString BowerbirdResetStartError 1033 "Cannot reset Bowerbird login. Please retry installation."
LangString BowerbirdResetStartError 2052 "无法重置 Bowerbird 登录状态，请重新安装。"
LangString BowerbirdResetFailedError 1033 "Bowerbird login reset failed. Please close Bowerbird and retry installation."
LangString BowerbirdResetFailedError 2052 "重置 Bowerbird 登录状态失败，请关闭 Bowerbird 后重新安装。"
!macro NSIS_HOOK_POSTINSTALL
  ${If} $UpdateMode != 1
    CreateDirectory "${BOWERBIRD_AUTH_DATA}"
    ClearErrors
    FileOpen $0 "${BOWERBIRD_AUTH_DATA}\installation-auth-reset.pending" w
    ${If} ${Errors}
      Abort "$(BowerbirdResetPrepareError)"
    ${EndIf}
    FileWrite $0 "1"
    FileClose $0
    ClearErrors
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --reset-install-auth' $0
    ${If} ${Errors}
      Abort "$(BowerbirdResetStartError)"
    ${EndIf}
    ${If} $0 != 0
      Abort "$(BowerbirdResetFailedError)"
    ${EndIf}
  ${EndIf}
!macroend
