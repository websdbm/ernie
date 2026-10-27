#!/usr/bin/env python3
"""Prepara un archivio senza firma per l'export Apple automatico conservando gli entitlement.

SPERIMENTALE: la preparazione ad hoc è verificata; l'export completo con tutti
 gli entitlement non è ancora validato. Non è il percorso ordinario di rilascio.
Non usa chiavi private e non produce un'app installabile. Copiare prima l'archivio;
poi esportare con xcodebuild e verificare firma/entitlement dell'IPA prima dell'upload.
"""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
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
        entitlements = expand(plistlib.loads(source.read_bytes()), team + '.')
        entitlements.update({'application-identifier': team + '.' + info['CFBundleIdentifier'],
                             'com.apple.developer.team-identifier': team, 'get-task-allow': False})
        # Un archivio già firmato da un'identità reale non va alterato.
        signature = subprocess.run(['/usr/bin/codesign', '-dv', '--verbose=2', str(bundle)], capture_output=True, text=True)
        if 'Authority=' in signature.stderr:
            raise ValueError(f'{target} è già firmato con un certificato: usare una copia senza firma')
        plans.append((target, bundle, source, entitlements))
    manifest = []
    with tempfile.TemporaryDirectory(prefix='ernie-cloud-entitlements-') as temporary:
        for target, bundle, source, entitlements in plans:
            path = Path(temporary) / f'{target}.plist'
            path.write_bytes(plistlib.dumps(entitlements))
            subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--entitlements', str(path),
                            '--generate-entitlement-der', str(bundle)], check=True)
            subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(bundle)], check=True)
            manifest.append({'target': target, 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                             'entitlements': entitlements})
    metadata = args.archive / 'Info.plist'
    archive_info = plistlib.loads(metadata.read_bytes())
    archive_info['ApplicationProperties']['Team'] = team
    metadata.write_bytes(plistlib.dumps(archive_info))
    (args.archive / 'cloud-signing-inputs.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('Preparati quattro bundle ad hoc con gli entitlement del progetto. Non installare né caricare direttamente.')
    print('Eseguire export Apple e verificare firma, permessi e isolamento del diario nell’IPA.')


if __name__ == '__main__':
    main()
