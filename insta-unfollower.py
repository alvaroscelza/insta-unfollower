#! /usr/bin/env python
# -*- coding: utf-8 -*-

import json
import os
import pickle
import random
import re
import sys
import time
from datetime import datetime

import requests
from dotenv import load_dotenv

CACHE_DIR = 'cache'
SESSION_CACHE = f'{CACHE_DIR}/session.txt'
CHECKPOINT_SESSION_CACHE = f'{CACHE_DIR}/session_checkpoint.pkl'
FOLLOWERS_CACHE = f'{CACHE_DIR}/followers.json'
FOLLOWING_CACHE = f'{CACHE_DIR}/following.json'
INSTAGRAM_URL = 'https://www.instagram.com'
# Copied from chrome://version → User-Agent. Chrome reports a reduced version (146.0.0.0) even when
# the full build is e.g. 146.0.7680.80 on Windows 11. After a major Chrome update, paste the new UA here.
CHROME_WINDOWS_UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/146.0.0.0 Safari/537.36'
)
LOGIN_ROUTE = f'{INSTAGRAM_URL}/accounts/login/ajax/'
PROFILE_ROUTE = f'{INSTAGRAM_URL}/api/v1/users/web_profile_info/'
RATE_LIMIT_BACKOFF_SECONDS = 600
# Human-like timing: min/max seconds between actions (jittered)
PAGINATION_DELAY_MIN = 2.5
PAGINATION_DELAY_MAX = 6.0
UNFOLLOW_DELAY_MIN = 6
UNFOLLOW_DELAY_MAX = 14
BETWEEN_PAGE_AND_UNFOLLOW_MIN = 2
BETWEEN_PAGE_AND_UNFOLLOW_MAX = 5
RETRY_AFTER_FAILURE_MIN = 45
RETRY_AFTER_FAILURE_MAX = 120
# Proactive rate limiting
MIN_SECONDS_BETWEEN_REQUESTS = 2.0
MAX_REQUESTS_PER_MINUTE = 18


def _human_delay(min_sec, max_sec):
    """Sleep for a random duration in [min_sec, max_sec] to simulate human behaviour."""
    time.sleep(random.uniform(min_sec, max_sec))


class Credentials:
    def __init__(self):
        if os.environ.get('INSTA_USERNAME') and os.environ.get('INSTA_PASSWORD'):
            self.username = os.environ.get('INSTA_USERNAME')
            self.password = os.environ.get('INSTA_PASSWORD')
        else:
            sys.exit('Please set INSTA_USERNAME and INSTA_PASSWORD environment variables.\nAborting...')


class InstaUnfollower:
    def __init__(self, credentials):
        self._credentials = credentials
        self._session = requests.Session()
        self._headers = None
        self._cookies = None
        self._request_timestamps = []

    def run(self):
        if os.environ.get('DRY_RUN'):
            print('DRY RUN MODE, script will not unfollow users!')
        self._ensure_cache_dir()
        self._load_headers_and_cookies()
        self._load_or_create_session()
        connected_user = self._get_user_profile(self._credentials.username)
        print(f"You're now logged as {connected_user['username']}")
        print(f"({connected_user['edge_followed_by']['count']} followers, {connected_user['edge_follow']['count']} following)")
        # --- Phased run: uncomment the next block when ready (rate-limit friendly) ---
        # _human_delay(2, 4)
        # following_list = self._load_or_build_following_list(connected_user)
        # followers_list = self._load_or_build_followers_list(connected_user)
        # unfollow_users_list = self._users_not_following_back(following_list, followers_list)
        # print(f"you are following {len(unfollow_users_list)} user(s) who aren't following you:")
        # for user in unfollow_users_list:
        #     print(user['username'])
        # if len(unfollow_users_list) > 0:
        #     print('Begin to unfollow users...')
        #     self._unfollow_all(unfollow_users_list)
        #     print(' done')

    def _ensure_cache_dir(self):
        if not os.path.isdir(CACHE_DIR):
            os.makedirs(CACHE_DIR)

    def _load_headers_and_cookies(self):
        self._headers, self._cookies = self._init_headers_and_cookies()
        requests.utils.add_dict_to_cookiejar(self._session.cookies, self._cookies)

    def _init_headers_and_cookies(self):
        headers = {'User-Agent': CHROME_WINDOWS_UA}
        res1 = self._session_get(INSTAGRAM_URL, headers=headers)
        ig_app_id = re.findall(r'X-IG-App-ID":"(.*?)"', res1.text)[0]
        res2 = self._session_get(f'{INSTAGRAM_URL}/data/shared_data/', headers=headers, cookies=res1.cookies)
        csrf = res2.json()['config']['csrf_token']
        if not csrf:
            print("No csrf token found in code or empty, maybe you are temp ban? Wait 1 hour and retry")
            sys.exit(1)
        headers['x-csrftoken'] = csrf
        headers['accept-language'] = "en-GB,en-US;q=0.9,en;q=0.8,fr;q=0.7,es;q=0.6,es-MX;q=0.5,es-ES;q=0.4"
        headers['x-requested-with'] = "XMLHttpRequest"
        headers['accept'] = "*/*"
        headers['referer'] = "https://www.instagram.com/"
        headers['x-ig-app-id'] = ig_app_id
        cookies = res1.cookies.get_dict()
        cookies['csrftoken'] = csrf
        _human_delay(2, 6)
        return headers, cookies

    def _session_get(self, url, **kwargs):
        self._wait_before_request()
        return self._session.get(url, **kwargs)

    def _session_post(self, url, **kwargs):
        self._wait_before_request()
        return self._session.post(url, **kwargs)

    def _wait_before_request(self):
        self._trim_request_timestamps_to_window()
        self._sleep_until_under_request_cap()
        self._sleep_if_needed_for_min_gap()
        self._record_request_time()

    def _trim_request_timestamps_to_window(self):
        now = time.time()
        self._request_timestamps = [t for t in self._request_timestamps if now - t < 60]

    def _sleep_until_under_request_cap(self):
        while len(self._request_timestamps) >= MAX_REQUESTS_PER_MINUTE:
            time.sleep(1)
            self._trim_request_timestamps_to_window()

    def _sleep_if_needed_for_min_gap(self):
        if not self._request_timestamps:
            return
        elapsed = time.time() - self._request_timestamps[-1]
        if elapsed < MIN_SECONDS_BETWEEN_REQUESTS:
            time.sleep(MIN_SECONDS_BETWEEN_REQUESTS - elapsed)

    def _record_request_time(self):
        self._request_timestamps.append(time.time())

    def _load_or_create_session(self):
        if os.path.isfile(SESSION_CACHE):
            with open(SESSION_CACHE, 'rb') as f:
                self._session.cookies.update(pickle.load(f))
            return
        if os.path.isfile(CHECKPOINT_SESSION_CACHE):
            with open(CHECKPOINT_SESSION_CACHE, 'rb') as f:
                self._session.cookies.update(pickle.load(f))
            self._sync_csrf_header_from_session()
        is_logged, _ = self._login()
        if not is_logged:
            sys.exit('login failed, verify user/password combination')
        if os.path.isfile(CHECKPOINT_SESSION_CACHE):
            os.remove(CHECKPOINT_SESSION_CACHE)
        with open(SESSION_CACHE, 'wb') as f:
            pickle.dump(self._session.cookies, f)
        _human_delay(2, 4)

    def _sync_csrf_header_from_session(self):
        csrf = self._session.cookies.get_dict().get('csrftoken') or self._cookies.get('csrftoken')
        if csrf:
            self._headers['x-csrftoken'] = csrf

    def _login(self):
        self._sync_csrf_header_from_session()
        post_data = {
            'username': self._credentials.username,
            'enc_password': f'#PWD_INSTAGRAM_BROWSER:0:{int(datetime.now().timestamp())}:{self._credentials.password}'
        }
        # Do not pass cookies= here: explicit cookies override the session jar and would replace
        # checkpoint cookies with a fresh homepage csrftoken after load_dotenv / second run.
        response = self._session_post(LOGIN_ROUTE, headers=self._headers, data=post_data, allow_redirects=True)
        response_data = self._parse_login_json(response)
        if 'two_factor_required' in response_data:
            print('Please disable 2-factor authentication to login.')
            sys.exit(1)
        if response_data.get('message') == 'checkpoint_required':
            with open(CHECKPOINT_SESSION_CACHE, 'wb') as f:
                pickle.dump(self._session.cookies, f)
            print('Instagram needs you to confirm this login (checkpoint).')
            print('Approve it in the Instagram app, then run this script again — the next run retries the same attempt instead of starting from scratch.')
            sys.exit(1)
        return response_data['authenticated'], response.cookies.get_dict()

    def _parse_login_json(self, response):
        text = (response.text or '').strip()
        if not text:
            print(f'Login response was empty (HTTP {response.status_code}). Try deleting cache/session_checkpoint.pkl and cache/session.txt, then run again.')
            sys.exit(1)
        try:
            return json.loads(response.text)
        except json.JSONDecodeError:
            preview = text[:300].replace('\n', ' ')
            print(f'Login response was not JSON (HTTP {response.status_code}): {preview!r}...')
            print('If you were in a checkpoint flow, delete cache/session_checkpoint.pkl and try again, or complete login in a browser.')
            sys.exit(1)

    def _get_user_profile(self, username):
        response = self._session_get(PROFILE_ROUTE, params={'username': username}, headers=self._headers).json()
        return response['data']['user']

    def _load_or_build_following_list(self, connected_user):
        following_list = self._load_json_cache(FOLLOWING_CACHE, 'following list')
        expected_count = connected_user['edge_follow']['count']
        if len(following_list) != expected_count:
            self._print_build_message('following', len(following_list) > 0)
            following_list = self._get_following_list(connected_user['id'])
            print(' done')
            self._save_json_cache(FOLLOWING_CACHE, following_list)
        return following_list

    def _load_json_cache(self, path, label):
        if not os.path.isfile(path):
            return []
        with open(path, 'r') as f:
            data = json.load(f)
        print(f'{label} loaded from cache file')
        return data

    def _save_json_cache(self, path, data):
        with open(path, 'w') as f:
            json.dump(data, f)

    def _print_build_message(self, list_name, rebuilding):
        prefix = 'rebuilding' if rebuilding else 'building'
        print(f'{prefix} {list_name} list...', end='', flush=True)

    def _get_following_list(self, user_id):
        return self._fetch_paginated_users(f'{INSTAGRAM_URL}/api/v1/friendships/{user_id}/following/')

    def _fetch_paginated_users(self, route):
        users = []
        _human_delay(1, 3)
        response = self._session_get(route, headers=self._headers).json()
        while response['status'] != 'ok':
            time.sleep(RATE_LIMIT_BACKOFF_SECONDS)
            response = self._session_get(route, headers=self._headers).json()
        print('.', end='', flush=True)
        users.extend(response['users'])
        while 'next_max_id' in response:
            _human_delay(PAGINATION_DELAY_MIN, PAGINATION_DELAY_MAX)
            response = self._session_get(route, params={'max_id': response['next_max_id']}, headers=self._headers).json()
            while response['status'] != 'ok':
                time.sleep(RATE_LIMIT_BACKOFF_SECONDS)
                response = self._session_get(route, params={'max_id': response['next_max_id']}, headers=self._headers).json()
            print('.', end='', flush=True)
            users.extend(response['users'])
        return users

    def _load_or_build_followers_list(self, connected_user):
        followers_list = self._load_json_cache(FOLLOWERS_CACHE, 'followers list')
        expected_count = connected_user['edge_followed_by']['count']
        if len(followers_list) != expected_count:
            self._print_build_message('followers', len(followers_list) > 0)
            followers_list = self._get_followers_list(connected_user['id'])
            print(' done')
            self._save_json_cache(FOLLOWERS_CACHE, followers_list)
        return followers_list

    def _get_followers_list(self, user_id):
        return self._fetch_paginated_users(f'{INSTAGRAM_URL}/api/v1/friendships/{user_id}/followers/')

    def _users_not_following_back(self, following_list, followers_list):
        followers_usernames = {u['username'] for u in followers_list}
        return [u for u in following_list if u['username'] not in followers_usernames]

    def _unfollow_all(self, unfollow_users_list):
        for user in unfollow_users_list:
            if not os.environ.get('UNFOLLOW_VERIFIED') and user.get('is_verified'):
                print(f"Skipping {user['username']}...")
                continue
            _human_delay(UNFOLLOW_DELAY_MIN, UNFOLLOW_DELAY_MAX)
            print(f"Unfollowing {user['username']}...")
            while not self._unfollow(user):
                sleep_time = random.uniform(RETRY_AFTER_FAILURE_MIN, RETRY_AFTER_FAILURE_MAX)
                print(f'Sleeping for {sleep_time:.0f} seconds before retry...')
                time.sleep(sleep_time)

    def _unfollow(self, user):
        if os.environ.get('DRY_RUN'):
            return True
        profile_page_url = f"{INSTAGRAM_URL}/{user['username']}/"
        response = self._session_get(profile_page_url, headers=self._headers)
        _human_delay(BETWEEN_PAGE_AND_UNFOLLOW_MIN, BETWEEN_PAGE_AND_UNFOLLOW_MAX)
        csrf_match = re.findall(r"csrf_token\":\"(.*?)\"", response.text)
        if csrf_match:
            self._session.headers.update({'x-csrftoken': csrf_match[0]})
        response = self._session_post(f"{INSTAGRAM_URL}/web/friendships/{user['id']}/unfollow/", headers=self._headers)
        if response.status_code == 429:
            print('Temporary ban from Instagram. Grab a coffee watch a TV show and comeback later. I will try again...')
            return False
        response_data = json.loads(response.text)
        if response_data['status'] != 'ok':
            print(f"Error while trying to unfollow {user['username']}. Retrying in a bit...")
            print(f'ERROR: {response.text}')
            return False
        return True


def main():
    load_dotenv()
    credentials = Credentials()
    InstaUnfollower(credentials).run()


if __name__ == "__main__":
    main()
