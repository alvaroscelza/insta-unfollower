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

CACHE_DIR = 'cache'
SESSION_CACHE = '%s/session.txt' % CACHE_DIR
FOLLOWERS_CACHE = '%s/followers.json' % CACHE_DIR
FOLLOWING_CACHE = '%s/following.json' % CACHE_DIR
INSTAGRAM_URL = 'https://www.instagram.com'
LOGIN_ROUTE = '%s/accounts/login/ajax/' % INSTAGRAM_URL
PROFILE_ROUTE = '%s/api/v1/users/web_profile_info/' % INSTAGRAM_URL
FOLLOWERS_ROUTE = '%s/api/v1/friendships/%%s/followers/' % INSTAGRAM_URL
FOLLOWING_ROUTE = '%s/api/v1/friendships/%%s/following/' % INSTAGRAM_URL
UNFOLLOW_ROUTE = '%s/web/friendships/%%s/unfollow/' % INSTAGRAM_URL
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
        print('You\'re now logged as {} ({} followers, {} following)'.format(
            connected_user['username'], connected_user['edge_followed_by']['count'], connected_user['edge_follow']['count']))
        _human_delay(2, 4)
        following_list = self._load_or_build_following_list(connected_user)
        followers_list = self._load_or_build_followers_list(connected_user)
        unfollow_users_list = self._users_not_following_back(following_list, followers_list)
        print('you are following {} user(s) who aren\'t following you:'.format(len(unfollow_users_list)))
        for user in unfollow_users_list:
            print(user['username'])
        if len(unfollow_users_list) > 0:
            print('Begin to unfollow users...')
            self._unfollow_all(unfollow_users_list)
            print(' done')

    def _ensure_cache_dir(self):
        if not os.path.isdir(CACHE_DIR):
            os.makedirs(CACHE_DIR)

    def _load_headers_and_cookies(self):
        self._headers, self._cookies = self._init_headers_and_cookies()

    def _init_headers_and_cookies(self):
        headers = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'}
        res1 = self._session_get(INSTAGRAM_URL, headers=headers)
        ig_app_id = re.findall(r'X-IG-App-ID":"(.*?)"', res1.text)[0]
        res2 = self._session_get('%s/data/shared_data/' % INSTAGRAM_URL, headers=headers, cookies=res1.cookies)
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
        is_logged, _ = self._login()
        if not is_logged:
            sys.exit('login failed, verify user/password combination')
        with open(SESSION_CACHE, 'wb') as f:
            pickle.dump(self._session.cookies, f)
        _human_delay(2, 4)

    def _login(self):
        post_data = {
            'username': self._credentials.username,
            'enc_password': '#PWD_INSTAGRAM_BROWSER:0:{}:{}'.format(int(datetime.now().timestamp()), self._credentials.password)
        }
        response = self._session_post(LOGIN_ROUTE, headers=self._headers, data=post_data, cookies=self._cookies, allow_redirects=True)
        response_data = json.loads(response.text)
        if 'two_factor_required' in response_data:
            print('Please disable 2-factor authentication to login.')
            sys.exit(1)
        if response_data.get('message') == 'checkpoint_required':
            print('Please check Instagram app for a security confirmation that it is you trying to login.')
            sys.exit(1)
        return response_data['authenticated'], response.cookies.get_dict()

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
        print('%s loaded from cache file' % label)
        return data

    def _save_json_cache(self, path, data):
        with open(path, 'w') as f:
            json.dump(data, f)

    def _print_build_message(self, list_name, rebuilding):
        prefix = 'rebuilding' if rebuilding else 'building'
        print('%s %s list...' % (prefix, list_name), end='', flush=True)

    def _get_following_list(self, user_id):
        return self._fetch_paginated_users(FOLLOWING_ROUTE % user_id)

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
        return self._fetch_paginated_users(FOLLOWERS_ROUTE % user_id)

    def _users_not_following_back(self, following_list, followers_list):
        followers_usernames = {u['username'] for u in followers_list}
        return [u for u in following_list if u['username'] not in followers_usernames]

    def _unfollow_all(self, unfollow_users_list):
        for user in unfollow_users_list:
            if not os.environ.get('UNFOLLOW_VERIFIED') and user.get('is_verified'):
                print('Skipping {}...'.format(user['username']))
                continue
            _human_delay(UNFOLLOW_DELAY_MIN, UNFOLLOW_DELAY_MAX)
            print('Unfollowing {}...'.format(user['username']))
            while not self._unfollow(user):
                sleep_time = random.uniform(RETRY_AFTER_FAILURE_MIN, RETRY_AFTER_FAILURE_MAX)
                print('Sleeping for {:.0f} seconds before retry...'.format(sleep_time))
                time.sleep(sleep_time)

    def _unfollow(self, user):
        if os.environ.get('DRY_RUN'):
            return True
        profile_page_url = '%s/%s/' % (INSTAGRAM_URL, user['username'])
        response = self._session_get(profile_page_url, headers=self._headers)
        _human_delay(BETWEEN_PAGE_AND_UNFOLLOW_MIN, BETWEEN_PAGE_AND_UNFOLLOW_MAX)
        csrf_match = re.findall(r"csrf_token\":\"(.*?)\"", response.text)
        if csrf_match:
            self._session.headers.update({'x-csrftoken': csrf_match[0]})
        response = self._session_post(UNFOLLOW_ROUTE % user['id'], headers=self._headers)
        if response.status_code == 429:
            print('Temporary ban from Instagram. Grab a coffee watch a TV show and comeback later. I will try again...')
            return False
        response_data = json.loads(response.text)
        if response_data['status'] != 'ok':
            print('Error while trying to unfollow {}. Retrying in a bit...'.format(user['username']))
            print('ERROR: {}'.format(response.text))
            return False
        return True


def main():
    credentials = Credentials()
    InstaUnfollower(credentials).run()


if __name__ == "__main__":
    main()
