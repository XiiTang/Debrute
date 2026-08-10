!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"

Var KeepDebruteConfigCheckbox
Var KeepDebruteConfig

!macro customCheckAppRunning
!macroend

!macro customInit
  ${GetOptions} $CMDLINE "/DEBRUTE_PRODUCT_UPDATE=" $0
  ${If} $0 != ""
    StrCpy $2 $0
    IfFileExists "$PROFILE\.debrute\products\current\runtime\debrute-runtime.exe" product_update_runtime_exists 0
    MessageBox MB_ICONSTOP|MB_OK "This Debrute Product Installer is not authorized by the pending Product update."
    Abort
    product_update_runtime_exists:
    nsExec::ExecToStack '"$PROFILE\.debrute\products\current\runtime\debrute-runtime.exe" preflight-product-update-installer --transaction-id "$2"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      DetailPrint "$1"
      MessageBox MB_ICONSTOP|MB_OK "This Debrute Product Installer is not authorized by the pending Product update."
      Abort
    ${EndIf}
    Goto product_version_preflight_finished
  ${EndIf}
  IfFileExists "$PROFILE\.debrute\products\current\runtime\debrute-runtime.exe" 0 product_version_preflight_finished
  nsExec::ExecToStack '"$PROFILE\.debrute\products\current\runtime\debrute-runtime.exe" preflight-product-version --product-version "${VERSION}"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "$1"
    MessageBox MB_ICONSTOP|MB_OK "This Debrute Product Installer cannot replace the installed Product."
    Abort
  ${EndIf}
  nsExec::ExecToStack '"$PROFILE\.debrute\products\current\runtime\debrute-runtime.exe" stop-product-for-installation'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "$1"
    MessageBox MB_ICONSTOP|MB_OK "The installed Debrute Product could not stop for installation."
    Abort
  ${EndIf}
  product_version_preflight_finished:
!macroend

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInstall
  ${GetOptions} $CMDLINE "/DEBRUTE_PRODUCT_UPDATE=" $0
  ${If} $0 != ""
    DetailPrint "Desktop payload installed for Product update transaction $0"
    Goto product_installation_finished
  ${EndIf}
  DetailPrint "Completing the Debrute Product installation"
  nsExec::ExecToStack '"$INSTDIR\resources\product-seed\runtime\debrute-runtime.exe" install-product --seed "$INSTDIR\resources\product-seed" --desktop-entrypoint "$INSTDIR\Debrute.exe" --desktop-arguments-json "[]"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "$1"
    MessageBox MB_ICONSTOP|MB_OK "Debrute could not complete the Product installation. No incomplete installation will be launched."
    Abort
  ${EndIf}
  product_installation_finished:
  Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  RMDir "$LOCALAPPDATA\@debrutedesktop-updater"
!macroend

!macro customUnWelcomePage
  UninstPage custom un.ProductRemovalPage un.ProductRemovalPageLeave
!macroend

Function un.ProductRemovalPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "Remove Debrute" "Remove the complete Product for this Windows user"
  ${NSD_CreateLabel} 0 0 100% 54u "This removes Desktop, Runtime, the debrute CLI, official Skills, and local Debrute state. Project contents are not removed."
  Pop $0
  ${NSD_CreateCheckbox} 0 62u 100% 24u "Keep settings and saved API keys for reinstall"
  Pop $KeepDebruteConfigCheckbox
  ${NSD_Uncheck} $KeepDebruteConfigCheckbox
  StrCpy $KeepDebruteConfig "0"
  nsDialogs::Show
FunctionEnd

Function un.ProductRemovalPageLeave
  ${NSD_GetState} $KeepDebruteConfigCheckbox $KeepDebruteConfig
FunctionEnd

!macro customUnInstall
  ${If} ${isUpdated}
    DetailPrint "Removing only the previous Desktop payload for Product installation"
    Goto product_removal_finished
  ${EndIf}
  SetOutPath "$TEMP"
  StrCpy $0 ""
  ${If} $KeepDebruteConfig == ${BST_CHECKED}
    StrCpy $0 "--keep-config"
  ${EndIf}
  DetailPrint "Committing whole-Product removal"
  nsExec::ExecToStack '"$SYSDIR\cmd.exe" /D /C call "$PROFILE\.debrute\bin\debrute.cmd" product uninstall --yes $0'
  Pop $1
  Pop $2
  ${If} $1 != 0
    DetailPrint "$2"
    MessageBox MB_ICONSTOP|MB_OK "Debrute could not commit Product removal. The installation was left in place."
    Abort
  ${EndIf}

  StrCpy $3 0
  wait_for_product_removal:
    IfFileExists "$INSTDIR\*.*" 0 product_removal_finished
    Sleep 250
    IntOp $3 $3 + 1
    IntCmp $3 480 product_removal_timeout wait_for_product_removal wait_for_product_removal
  product_removal_timeout:
    MessageBox MB_ICONSTOP|MB_OK "Debrute removal did not finish within two minutes."
    Abort
  product_removal_finished:
!macroend
