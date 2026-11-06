; Ajouts à l'installateur standard.
; Il désinstalle déjà la version enregistrée dans Windows : on cherche ici ce que le registre ne connaît pas.

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    LangString rechercheAnciennes 1036 "Recherche des anciennes versions..."
    LangString rechercheAnciennes 1033 "Looking for older versions..."
    LangString rechercheAnciennes 3082 "Buscando versiones anteriores..."
  !endif
!macroend

!macro customInstall
  ; Une mise à jour automatique remplace déjà la version en place et doit rester rapide.
  ${ifNot} ${isUpdated}
    SetDetailsPrint textonly
    DetailPrint "$(rechercheAnciennes)"
    SetDetailsPrint none
    File "/oname=$PLUGINSDIR\anciennes-versions.ps1" "${BUILD_RESOURCES_DIR}\anciennes-versions.ps1"
    ; Le résultat est ignoré : un échec ici ne doit jamais empêcher l'installation.
    nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\anciennes-versions.ps1" -Garder "$INSTDIR" -Produit "${PRODUCT_NAME}" -Exe "${APP_EXECUTABLE_FILENAME}" -Version "${VERSION}" -Installateur "$EXEPATH"'
    Pop $0
  ${endIf}
!macroend
