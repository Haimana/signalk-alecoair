#!/usr/bin/env python3
"""One-shot Smart Life QR login + device list. No iot.tuya.com project."""
import json
import sys

CLIENT_ID = 'HA_3y9q4ak7g4ephrvke'
SCHEMA = 'haauthorize'
QR_PREFIXES = (
    'tuyaSmart--qrLogin?token=',
    'alecoair--qrLogin?token=',
)


def out(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.write('\n')


def start(user_code):
    from tuya_sharing import LoginControl
    resp = LoginControl().qr_code(CLIENT_ID, SCHEMA, user_code)
    if not resp.get('success'):
        out({'ok': False, 'error': resp.get('msg') or 'QR login did not start. Check the User Code.'})
        return 1
    token = resp['result']['qrcode']
    out({
        'ok': True,
        'token': token,
        'qrText': QR_PREFIXES[0] + token,
        'qrTexts': {
            'smartlife': QR_PREFIXES[0] + token,
            'alecoair': QR_PREFIXES[1] + token
        }
    })
    return 0


def poll(token, user_code):
    from tuya_sharing import LoginControl
    try:
        ok, info = LoginControl().login_result(token, CLIENT_ID, user_code)
    except Exception as err:
        out({'ok': False, 'pending': True, 'error': str(err)})
        return 0
    if not ok:
        out({'ok': False, 'pending': True})
        return 0
    session = {
        'client_id': CLIENT_ID,
        'user_code': user_code,
        'terminal_id': info.get('terminal_id'),
        'endpoint': info.get('endpoint') or info.get('end_point'),
        'token_info': {
            't': info.get('t'),
            'uid': info.get('uid'),
            'expire_time': info.get('expire_time'),
            'access_token': info.get('access_token'),
            'refresh_token': info.get('refresh_token')
        }
    }
    out({'ok': True, 'pending': False, 'session': session})
    return 0


def devices(session):
    from tuya_sharing import Manager

    class Saver:
        def update_token(self, token_info):
            return None

    manager = Manager(
        session.get('client_id', CLIENT_ID),
        session['user_code'],
        session['terminal_id'],
        session['endpoint'],
        session['token_info'],
        Saver()
    )
    manager.update_device_cache()
    found = []
    for device in manager.device_map.values():
        found.append({
            'id': getattr(device, 'id', ''),
            'name': getattr(device, 'name', ''),
            'localKey': getattr(device, 'local_key', '') or '',
            'ip': getattr(device, 'ip', '') or '',
            'productName': getattr(device, 'product_name', '') or '',
            'productId': getattr(device, 'product_id', '') or '',
            'category': getattr(device, 'category', '') or '',
            'online': bool(getattr(device, 'online', False)),
            'uuid': getattr(device, 'uuid', '') or ''
        })
    out({'ok': True, 'devices': found})
    return 0


def read_session(argv):
    if len(argv) > 2 and argv[2]:
        return json.loads(argv[2])
    return json.load(sys.stdin)


def main(argv):
    if len(argv) < 2:
        out({'ok': False, 'error': 'usage: start|poll|devices'})
        return 2
    cmd = argv[1]
    try:
        if cmd == 'start':
            return start(argv[2])
        if cmd == 'poll':
            return poll(argv[2], argv[3])
        if cmd == 'devices':
            return devices(read_session(argv))
        out({'ok': False, 'error': 'unknown command'})
        return 2
    except ImportError:
        out({'ok': False, 'error': 'Missing tuya-device-sharing-sdk. Create plugin/.venv and pip install -r requirements.txt'})
        return 1
    except Exception as err:
        out({'ok': False, 'error': str(err)})
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv) or 0)
