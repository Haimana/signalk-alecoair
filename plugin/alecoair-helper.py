#!/usr/bin/env python3
"""Log in to the AlecoAir OEM cloud (same API as the phone app) and list devices."""
import hashlib
import hmac
import json
import sys
import time

import requests

CLIENT_ID = 'pvufcdrftnfkt4rqkxs5'
SECRET = 'A_48vafqcmrfx4mvjrph4j4ayfe9hctnkd_jmehruant8ag7nscxn8u47u9yf8h48e7'
UA = 'TY-UA=APP/Android/1.1.6/SDK/null'


def out(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.write('\n')


def mobile_hash(data):
    prehash = hashlib.md5(data.encode('utf-8')).hexdigest()
    return prehash[8:16] + prehash[0:8] + prehash[24:32] + prehash[16:24]


def sign(payload):
    parts = []
    for key in sorted(payload):
        if key == 'gid':
            continue
        value = mobile_hash(payload[key]) if key == 'postData' else payload[key]
        parts.append('%s=%s' % (key, value))
    return hmac.new(SECRET.encode('utf-8'), '||'.join(parts).encode('utf-8'), hashlib.sha256).hexdigest()


def rsa_encrypt(modulus, exponent, message):
    message_int = int.from_bytes(message, 'big')
    enc = pow(message_int, int(exponent), int(modulus))
    return enc.to_bytes(256, 'big')


class AlecoAirCloud:
    def __init__(self, region):
        self.endpoint = 'https://a1.tuya%s.com/api.json' % region
        self.session = requests.session()
        self.sid = None

    def api(self, action, payload=None, extra=None, need_sid=True):
        params = {
            'a': action,
            'clientId': CLIENT_ID,
            'v': '1.0',
            'time': str(int(time.time()))
        }
        if extra:
            params.update(extra)
        if need_sid:
            if not self.sid:
                raise ValueError('Not logged in.')
            params['sid'] = self.sid
        data = {}
        if payload is not None:
            data['postData'] = json.dumps(payload, separators=(',', ':'))
        params['sign'] = sign({**params, **data})
        resp = self.session.post(self.endpoint, params=params, data=data, headers={'User-Agent': UA}, timeout=20)
        body = resp.json()
        if not body.get('success'):
            raise ValueError(body.get('errorMsg') or body.get('errorCode') or 'AlecoAir login failed.')
        return body.get('result')

    def login_email(self, email, password):
        token_info = self.api('tuya.m.user.email.token.create', {
            'countryCode': '',
            'email': email
        }, need_sid=False)
        passwd = rsa_encrypt(
            token_info['publicKey'],
            token_info['exponent'],
            hashlib.md5(password.encode('utf8')).hexdigest().encode('utf8')
        ).hex()
        info = self.api('tuya.m.user.email.password.login', {
            'countryCode': '',
            'email': email,
            'ifencrypt': 1,
            'options': '{"group": 1}',
            'passwd': passwd,
            'token': token_info['token']
        }, need_sid=False)
        self.sid = info['sid']

    def login_mobile(self, mobile, password, country='40'):
        token_info = self.api('tuya.m.user.mobile.token.create', {
            'countryCode': country,
            'mobile': mobile
        }, need_sid=False)
        passwd = rsa_encrypt(
            token_info['publicKey'],
            token_info['exponent'],
            hashlib.md5(password.encode('utf8')).hexdigest().encode('utf8')
        ).hex()
        info = self.api('tuya.m.user.mobile.password.login', {
            'countryCode': country,
            'mobile': mobile,
            'ifencrypt': 1,
            'options': '{"group": 1}',
            'passwd': passwd,
            'token': token_info['token']
        }, need_sid=False)
        self.sid = info['sid']

    def devices(self):
        found = []
        for group in self.api('tuya.m.location.list') or []:
            for dev in self.api('tuya.m.my.group.device.list', extra={'gid': group['groupId']}) or []:
                found.append({
                    'id': dev.get('devId') or '',
                    'name': dev.get('name') or '',
                    'localKey': dev.get('localKey') or '',
                    'ip': dev.get('ip') or '',
                    'productName': dev.get('productName') or '',
                    'productId': dev.get('productId') or '',
                    'category': dev.get('category') or '',
                    'online': bool(dev.get('isOnline') or dev.get('online')),
                    'uuid': dev.get('uuid') or ''
                })
        return found


def main(argv):
    if len(argv) < 2 or argv[1] != 'login':
        out({'ok': False, 'error': 'usage: login < json'})
        return 2
    try:
        body = json.load(sys.stdin)
        account = (body.get('account') or body.get('email') or '').strip()
        password = body.get('password') or ''
        region = (body.get('region') or 'eu').strip() or 'eu'
        if not account or not password:
            out({'ok': False, 'error': 'AlecoAir email/phone and password are required.'})
            return 1
        cloud = AlecoAirCloud(region)
        if '@' in account:
            cloud.login_email(account, password)
        else:
            cloud.login_mobile(account.lstrip('+'), password, body.get('countryCode') or '40')
        devices = cloud.devices()
        out({'ok': True, 'devices': devices})
        return 0
    except Exception as err:
        out({'ok': False, 'error': str(err)})
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv) or 0)
