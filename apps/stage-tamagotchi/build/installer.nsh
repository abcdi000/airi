!macro customInstall
  CreateShortCut "$INSTDIR\Lumi Server Manager.lnk" "$INSTDIR\lumi.exe" "--lumi-server-manager"
  CreateShortCut "$DESKTOP\Lumi Server Manager.lnk" "$INSTDIR\lumi.exe" "--lumi-server-manager"
  CreateShortCut "$SMPROGRAMS\Lumi Server Manager.lnk" "$INSTDIR\lumi.exe" "--lumi-server-manager"
!macroend

!macro customUnInstall
  Delete "$INSTDIR\Lumi Server Manager.lnk"
  Delete "$DESKTOP\Lumi Server Manager.lnk"
  Delete "$SMPROGRAMS\Lumi Server Manager.lnk"
!macroend
