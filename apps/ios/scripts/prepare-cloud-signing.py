#!/usr/bin/env python3
"""Prepara un archivio senza firma per l'export Apple automatico conservando gli entitlement.

Procedura verificata sulla build 107 con i profili Apple validi dell'archivio
precedente. Verificare sempre firma e permessi dell'IPA esportata prima dell'upload.
Non usa chiavi private e non produce un'app installabile. Copiare prima l'archivio;
poi esportare con xcodebuild e verificare firma/entitlement dell'IPA prima dell'upload.
"""
import argparse
from datetime import datetime, timezone
import fnmatch
import hashlib
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile

TARGETS = ('Ernie', 'ErnieNotifications', 'ErnieShare', 'ErnieWidgets')


def expand(value, prefix):
    if isinstance(value, str):
        result = value.replace('$(AppIdentifierPrefix)', prefix)
        if '$(' in result:
            raise ValueError(f'Variabile non risolta negli entitlement: {result}')
        return result
    if isinstance(value, list):
        return [expand(v, prefix) for v in value]
    if isinstance(value, dict):
        return {k: expand(v, prefix) for k, v in value.items()}
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--profiles-from", type=Path, required=True, help="Archivio precedente con profili Apple validi dello stesso team e bundle")
    args = parser.parse_args()
    team = plistlib.loads((args.source / 'ExportOptions.plist').read_bytes())['teamID']
    app = args.archive / 'Products/Applications/Ernie.app'
    extensions = {p.stem: p for p in (app / 'PlugIns').glob('*.appex')}
    if set(extensions) != set(TARGETS[1:]):
        raise ValueError('Estensioni diverse dalle tre previste dal progetto')
    plans = []
    for target in (*TARGETS[1:], TARGETS[0]):
        bundle = app if target == 'Ernie' else extensions[target]
        info = plistlib.loads((bundle / 'Info.plist').read_bytes())
        source = args.source / target / f'{target}.entitlements'
        prefix = team
        profile_source = None
        if args.profiles_from:
            template = args.profiles_from / 'Products/Applications/Ernie.app'
            if target != 'Ernie': template = template / 'PlugIns' / f'{target}.appex'
            profile_source = template / 'embedded.mobileprovision'
            profile = plistlib.loads(subprocess.check_output(
                ['/usr/bin/security', 'cms', '-D', '-i', str(profile_source)], stderr=subprocess.DEVNULL))
            if team not in profile['TeamIdentifier']:
                raise ValueError(f'{target}: team del profilo diverso')
            if profile['ExpirationDate'].replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc):
                raise ValueError(f'{target}: profilo scaduto')
            prefix = profile['ApplicationIdentifierPrefix'][0]
            app_id = prefix + '.' + info['CFBundleIdentifier']
            if not fnmatch.fnmatchcase(app_id, profile['Entitlements']['application-identifier']):
                raise ValueError(f'{target}: profilo di un altro bundle')
        entitlements = expand(plistlib.loads(source.read_bytes()), prefix + '.')
        entitlements.update({'application-identifier': prefix + '.' + info['CFBundleIdentifier'],
                             'com.apple.developer.team-identifier': team, 'get-task-allow': False})
        # Un archivio già firmato da un'identità reale non va alterato.
        signature = subprocess.run(['/usr/bin/codesign', '-dv', '--verbose=2', str(bundle)], capture_output=True, text=True)
        if 'Authority=' in signature.stderr:
            raise ValueError(f'{target} è già firmato con un certificato: usare una copia senza firma')
        plans.append((target, bundle, source, entitlements, profile_source))
    manifest = []
    with tempfile.TemporaryDirectory(prefix='ernie-cloud-entitlements-') as temporary:
        for target, bundle, source, entitlements, profile_source in plans:
            if profile_source: shutil.copyfile(profile_source, bundle / "embedded.mobileprovision")
            path = Path(temporary) / f'{target}.plist'
            path.write_bytes(plistlib.dumps(entitlements))
            subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--entitlements', str(path),
                            '--generate-entitlement-der', str(bundle)], check=True)
            subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(bundle)], check=True)
            manifest.append({'target': target, 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                             'entitlements': entitlements,
                             'profileSha256': hashlib.sha256(profile_source.read_bytes()).hexdigest() if profile_source else None})
    metadata = args.archive / 'Info.plist'
    archive_info = plistlib.loads(metadata.read_bytes())
    archive_info['ApplicationProperties']['Team'] = team
    metadata.write_bytes(plistlib.dumps(archive_info))
    (args.archive / 'cloud-signing-inputs.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('Preparati quattro bundle ad hoc con gli entitlement del progetto. Non installare né caricare direttamente.')
    print('Eseguire export Apple e verificare firma, permessi e isolamento del diario nell’IPA.')


if __name__ == '__main__':
    main()
