; Tauri sets UpdateMode for application updates: preserve the existing login.
; Ordinary installs/reinstalls still reset; an interrupted reset keeps its marker.
!ifndef BOWERBIRD_AUTH_DATA
  !define BOWERBIRD_AUTH_DATA "$APPDATA\${BUNDLEID}"
!endif
!macro NSIS_HOOK_POSTINSTALL
  ${If} $UpdateMode != 1
    CreateDirectory "${BOWERBIRD_AUTH_DATA}"
    ClearErrors
    FileOpen $0 "${BOWERBIRD_AUTH_DATA}\installation-auth-reset.pending" w
    ${If} ${Errors}
      Abort "Cannot prepare Bowerbird login reset. Please retry installation."
    ${EndIf}
    FileWrite $0 "1"
    FileClose $0
    ClearErrors
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --reset-install-auth' $0
    ${If} ${Errors}
      Abort "Cannot reset Bowerbird login. Please retry installation."
    ${EndIf}
    ${If} $0 != 0
      Abort "Bowerbird login reset failed. Please close Bowerbird and retry installation."
    ${EndIf}
  ${EndIf}
!macroend
