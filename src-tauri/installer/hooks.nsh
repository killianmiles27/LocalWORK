; LocalWORK installer hooks (Tauri NSIS).
; The uninstaller removes the program folder only. User data in %LOCALAPPDATA%\Workbench is kept
; unless the "Delete the application data" checkbox (off by default) is ticked. Strata and the
; models live outside the install and are never touched.

!macro NSIS_HOOK_PREINSTALL
  ; Make sure a running copy does not block file replacement during an update.
  nsExec::Exec 'taskkill /F /IM LocalWORK.exe /T'
  Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    RmDir /r "$LOCALAPPDATA\Workbench"
  ${EndIf}
!macroend
