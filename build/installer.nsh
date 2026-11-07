; Ajouts à l'installateur standard.
; Il désinstalle déjà la version enregistrée dans Windows. Le launcher retire lui-même, à son prochain
; démarrage, ce que le registre ne connaît pas (voir src/main/core/anciennes-versions.js).

!macro customInstall
  ; Une mise à jour automatique remplace déjà la version en place : rien à demander dans ce cas.
  ${ifNot} ${isUpdated}
    ; La marque nomme la copie à garder. Un échec ici ne doit jamais empêcher l'installation.
    CreateDirectory "$APPDATA\${PRODUCT_NAME}"
    ClearErrors
    FileOpen $0 "$APPDATA\${PRODUCT_NAME}\anciennes-versions.a-nettoyer" w
    ${ifNot} ${Errors}
      FileWriteUTF16LE $0 "$INSTDIR"
      FileClose $0
    ${endIf}
  ${endIf}
!macroend
