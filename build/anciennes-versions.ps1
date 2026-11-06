# Lancé par l'installateur une fois la nouvelle version en place (voir installer.nsh).
# Retire les copies du launcher que le registre de Windows ne connaît pas :
#   - un dossier d'installation orphelin ;
#   - les exécutables portables et les installateurs plus anciens que cette version.
# Puis répare les raccourcis qui visaient une copie disparue.
#
# Ne touche jamais aux données du joueur : elles sont dans AppData, que l'analyse ne parcourt pas.
# Un fichier n'est retenu que si son nom ET le nom de produit inscrit dans l'exécutable correspondent.
# Dans un dossier orphelin, seuls les éléments portant le nom d'un fichier de l'application sont retirés.
# L'analyse est bornée dans le temps et aucune erreur ne remonte à l'installateur.
param(
  [Parameter(Mandatory = $true)][string]$Garder,
  [Parameter(Mandatory = $true)][string]$Produit,
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Installateur = '',
  [string[]]$Racines = @(),
  [string[]]$Raccourcis = @(),
  [int]$Secondes = 10
)

$ErrorActionPreference = 'SilentlyContinue'

$garde = [IO.Path]::GetFullPath($Garder).TrimEnd('\')
$nouvelle = [version]($Version -replace '[-+].*$', '')
$prefixe = $Produit -replace ' ', '-'
$limite = [DateTime]::UtcNow.AddSeconds($Secondes)
$ignores = 'AppData', 'ProgramData', 'Windows', 'node_modules', '$Recycle.Bin', 'System Volume Information'

$vus = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$dossiers = New-Object 'System.Collections.Generic.List[string]'
$fichiers = New-Object 'System.Collections.Generic.List[string]'
$journal = New-Object 'System.Collections.Generic.List[string]'

function Test-Dans([string]$chemin, [string]$dossier) {
  $chemin.Equals($dossier, [StringComparison]::OrdinalIgnoreCase) -or
    $chemin.StartsWith("$dossier\", [StringComparison]::OrdinalIgnoreCase)
}

function Test-NomDuLauncher([string]$nom) {
  ($nom -ieq $Exe) -or ($nom -like "$prefixe-*.exe")
}

function Test-Fichier([IO.FileInfo]$fichier) {
  if ($fichier.FullName -ieq $Installateur -or -not (Test-NomDuLauncher $fichier.Name)) { return }
  $infos = [Diagnostics.FileVersionInfo]::GetVersionInfo($fichier.FullName)
  if ($infos.ProductName -cne $Produit) { return }

  if ($fichier.Name -ieq $Exe) {
    # Sans ses ressources, ce n'est qu'un exécutable renommé ou incomplet : on n'y touche pas.
    if (Test-Path -LiteralPath (Join-Path $fichier.DirectoryName 'resources\app.asar')) {
      $dossiers.Add($fichier.DirectoryName)
    }
  } elseif ([version]::new($infos.FileMajorPart, $infos.FileMinorPart, $infos.FileBuildPart) -lt $nouvelle) {
    $fichiers.Add($fichier.FullName)
  }
}

# Parcours en largeur : les dossiers proches de la racine passent d'abord si le temps manque.
function Invoke-Analyse([string[]]$depart) {
  $attente = New-Object System.Collections.Queue
  foreach ($racine in $depart) { $attente.Enqueue($racine) }

  while ($attente.Count -gt 0 -and [DateTime]::UtcNow -lt $limite) {
    $dossier = $attente.Dequeue()
    if (-not $vus.Add($dossier) -or (Test-Dans $dossier $garde)) { continue }
    try {
      $infos = [IO.DirectoryInfo]::new($dossier)
      $sous = $infos.GetDirectories()
      # Un dépôt de code contient des versions de travail, pas des versions installées.
      if ($sous.Name -contains '.git') { continue }
      foreach ($fichier in $infos.GetFiles('*.exe')) { Test-Fichier $fichier }
      foreach ($enfant in $sous) {
        $lien = $enfant.Attributes -band [IO.FileAttributes]::ReparsePoint
        if ($lien -or $enfant.Name.StartsWith('.') -or $ignores -contains $enfant.Name) { continue }
        $attente.Enqueue($enfant.FullName)
      }
    } catch {}
  }
}

function Stop-AnciensProcessus {
  # Une copie portable tourne depuis le dossier temporaire et son exécutable reste verrouillé tant qu'elle vit.
  $temp = [IO.Path]::GetTempPath().TrimEnd('\')
  $nom = [IO.Path]::GetFileNameWithoutExtension($Exe)
  $application = Get-Process -Name $nom | Where-Object {
    $chemin = $_.Path
    $chemin -and -not (Test-Dans $chemin $garde) -and
      ((Test-Dans $chemin $temp) -or ($dossiers | Where-Object { Test-Dans $chemin $_ }))
  }
  if ($application) {
    $application | Stop-Process -Force
    Start-Sleep -Milliseconds 800
  }
  $portables = Get-Process | Where-Object { $_.Path -and $fichiers -icontains $_.Path }
  if ($portables) {
    $portables | Stop-Process -Force
    Start-Sleep -Milliseconds 300
  }
}

function Remove-Dossier([string]$dossier, [string[]]$contenu) {
  foreach ($nom in $contenu) {
    Remove-Item -LiteralPath (Join-Path $dossier $nom) -Recurse -Force
  }
  if (-not (Get-ChildItem -LiteralPath $dossier -Force | Select-Object -First 1)) {
    Remove-Item -LiteralPath $dossier -Force
  }
  $journal.Add("Dossier retire : $dossier")
}

function Repair-Raccourcis([string[]]$emplacements) {
  $coquille = New-Object -ComObject WScript.Shell
  $nouvelExe = Join-Path $garde $Exe
  foreach ($emplacement in $emplacements) {
    foreach ($fichier in Get-ChildItem -LiteralPath $emplacement -Filter '*.lnk' -Recurse -Depth 2) {
      $raccourci = $coquille.CreateShortcut($fichier.FullName)
      $cible = $raccourci.TargetPath
      if (-not $cible -or -not (Test-NomDuLauncher (Split-Path $cible -Leaf))) { continue }
      if (Test-Path -LiteralPath $cible) { continue }
      $raccourci.TargetPath = $nouvelExe
      $raccourci.WorkingDirectory = $garde
      $raccourci.IconLocation = "$nouvelExe,0"
      $raccourci.Save()
      $journal.Add("Raccourci repare : $($fichier.FullName)")
    }
  }
}

try {
  if ($Racines.Count -gt 0) {
    Invoke-Analyse $Racines
  } else {
    # Le dossier personnel d'abord : c'est là qu'un joueur garde ses téléchargements.
    Invoke-Analyse @((Join-Path $env:LOCALAPPDATA 'Programs'), $env:USERPROFILE)
    $disques = [IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady }
    Invoke-Analyse @($disques | ForEach-Object { $_.RootDirectory.FullName })
  }

  if ($dossiers.Count -gt 0 -or $fichiers.Count -gt 0) {
    Stop-AnciensProcessus
    $contenu = @(Get-ChildItem -LiteralPath $garde -Force | ForEach-Object { $_.Name })
    # Le dossier de l'application doit être listé en entier, sinon on ne sait pas quoi retirer.
    if ($contenu -contains $Exe) {
      foreach ($dossier in $dossiers) { Remove-Dossier $dossier $contenu }
    }
    foreach ($fichier in $fichiers) {
      Remove-Item -LiteralPath $fichier -Force
      if (-not (Test-Path -LiteralPath $fichier)) { $journal.Add("Fichier retire : $fichier") }
    }
  }

  if ($Raccourcis.Count -eq 0) {
    $Raccourcis = @(
      [Environment]::GetFolderPath('Desktop'),
      [Environment]::GetFolderPath('Programs'),
      (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
    )
  }
  Repair-Raccourcis $Raccourcis

  if ($journal.Count -gt 0) {
    $journal
    $dossierDonnees = Join-Path $env:APPDATA $Produit
    New-Item -ItemType Directory -Path $dossierDonnees -Force | Out-Null
    $journal | Set-Content -LiteralPath (Join-Path $dossierDonnees 'anciennes-versions.log') -Encoding UTF8
  }
} catch {}

exit 0
