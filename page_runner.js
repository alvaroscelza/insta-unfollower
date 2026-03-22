/**
 * Runs in the page main world on instagram.com. Config JSON in sessionStorage __ig_unfollow__:
 * { command: 'counts' | 'load_unfollowers' | 'unfollow', whitelist?: string[] }
 */
'use strict';

const ORIGIN = 'https://www.instagram.com';
const RATE_LIMIT_MS = 600_000;
const MIN_GAP_MS = 2000;
const MAX_PER_MIN = 18;
const PAGINATION_MIN = 2500;
const PAGINATION_MAX = 6000;
const UNFOLLOW_MIN = 6000;
const UNFOLLOW_MAX = 14_000;
const BETWEEN_PAGE_UNFOLLOW_MIN = 2000;
const BETWEEN_PAGE_UNFOLLOW_MAX = 5000;
const FRIENDSHIP_PAGE_COUNT = 200;

const SK_USER_ID = '__ig_session_user_id__';
const SK_USER_NAME = '__ig_session_username__';
const SK_UNFOLLOWERS_LIST = '__ig_unfollowers_list__';
const SK_UNFOLLOWERS_COUNT = '__ig_unfollowers_count__';
const SK_UNFOLLOWERS_READY = '__ig_unfollowers_ready__';
const SK_COUNT_FOLLOWING = '__ig_count_following__';
const SK_COUNT_FOLLOWERS = '__ig_count_followers__';
const SK_CANCEL = '__ig_unfollow_cancel__';
const SK_LOAD_PROGRESS = '__ig_load_progress__';

class InstaUnfollowRunner {
    constructor() {
        this._igAppId = null;
        this._asbdId = null;
        this._requestTimes = [];
    }

    async main() {
        if (sessionStorage.getItem('__ig_unfollow_lock__') === '1') {
            this.log('A run is already in progress in this tab.');
            this.setStatus('error');
            this.setResult({ ok: false, error: 'Already running' });
            return;
        }
        sessionStorage.setItem('__ig_unfollow_lock__', '1');
        sessionStorage.removeItem(SK_CANCEL);
        sessionStorage.removeItem('__ig_unfollow_log__');
        sessionStorage.removeItem('__ig_unfollow_result__');
        this.setStatus('running');
        let config;
        try {
            config = JSON.parse(sessionStorage.getItem('__ig_unfollow__') || '{}');
        } catch {
            this.setStatus('error');
            this.setResult({ ok: false, error: 'Bad config JSON' });
            sessionStorage.removeItem('__ig_unfollow_lock__');
            return;
        }
        const command = config.command || 'counts';
        try {
            if (command === 'counts') {
                await this.runCounts();
            } else if (command === 'load_unfollowers') {
                await this.runLoadUnfollowers();
            } else if (command === 'unfollow') {
                await this.runUnfollow(Array.isArray(config.whitelist) ? config.whitelist : []);
            } else {
                throw new Error('Unknown command: ' + command);
            }
            this.setStatus('done');
        } catch (e) {
            if (e && e.name === 'UserCancelled') {
                this.log('Stopped by user.');
                this.setResult({ ok: false, cancelled: true, command });
                this.setStatus('done');
            } else {
                this.log('Error: ' + (e && e.message ? e.message : String(e)));
                this.setStatus('error');
                this.setResult({ ok: false, error: e && e.message ? e.message : String(e), command });
            }
        } finally {
            sessionStorage.removeItem('__ig_unfollow_lock__');
        }
    }

    log(line) {
        const key = '__ig_unfollow_log__';
        const prev = sessionStorage.getItem(key) || '';
        sessionStorage.setItem(key, prev + line + '\n');
    }

    setStatus(s) {
        sessionStorage.setItem('__ig_unfollow_status__', s);
    }

    setResult(obj) {
        sessionStorage.setItem('__ig_unfollow_result__', JSON.stringify(obj));
    }

    setLoadProgress(updates) {
        let base = {};
        try {
            base = JSON.parse(sessionStorage.getItem(SK_LOAD_PROGRESS) || '{}');
        } catch {
            base = {};
        }
        const next = { ...base };
        for (const k of Object.keys(updates)) {
            if (updates[k] !== undefined) next[k] = updates[k];
        }
        next.lastActivityAt = Date.now();
        sessionStorage.setItem(SK_LOAD_PROGRESS, JSON.stringify(next));
    }

    bumpLoadProgress() {
        const raw = sessionStorage.getItem(SK_LOAD_PROGRESS);
        if (!raw) return;
        try {
            const o = JSON.parse(raw);
            o.lastActivityAt = Date.now();
            sessionStorage.setItem(SK_LOAD_PROGRESS, JSON.stringify(o));
        } catch {
            /* ignore */
        }
    }

    clearLoadProgress() {
        sessionStorage.removeItem(SK_LOAD_PROGRESS);
    }

    countUnfollowersInCache() {
        try {
            const raw = sessionStorage.getItem(SK_UNFOLLOWERS_LIST);
            if (!raw) return 0;
            const a = JSON.parse(raw);
            return Array.isArray(a) ? a.length : 0;
        } catch {
            return 0;
        }
    }

    normalizeUsernameKey(u) {
        return u && u.username != null ? String(u.username).trim().replace(/^@+/, '').toLowerCase() : '';
    }

    userPkOrId(u) {
        if (!u || typeof u !== 'object') return '';
        const v = u.pk != null ? u.pk : u.id;
        return v != null ? String(v) : '';
    }

    removeUserFromUnfollowersCache(user) {
        const uname = this.normalizeUsernameKey(user);
        const uid = this.userPkOrId(user);
        let raw = sessionStorage.getItem(SK_UNFOLLOWERS_LIST);
        if (!raw) return;
        let list;
        try {
            list = JSON.parse(raw);
        } catch {
            return;
        }
        if (!Array.isArray(list)) return;
        const next = list.filter((entry) => {
            const ename = this.normalizeUsernameKey(entry);
            const eid = this.userPkOrId(entry);
            if (uname && ename === uname) return false;
            if (uid && eid && uid === eid) return false;
            return true;
        });
        sessionStorage.setItem(SK_UNFOLLOWERS_LIST, JSON.stringify(next));
        sessionStorage.setItem(SK_UNFOLLOWERS_COUNT, String(next.length));
        if (next.length === 0) {
            sessionStorage.setItem(SK_UNFOLLOWERS_READY, '0');
        }
    }

    async runCounts() {
        const u = await this.requireLoggedInUser();
        const username = u.username;
        if (!username) {
            throw new Error('Could not determine your username — open your profile on instagram.com once, then Refresh counts.');
        }
        let userId = u.pk != null ? u.pk : u.id;
        const me = await this.getWebProfile(username);
        if (userId == null) {
            userId = me.id;
        }
        const followingCount = me.edge_follow?.count ?? 0;
        const followersCount = me.edge_followed_by?.count ?? 0;
        sessionStorage.removeItem(SK_UNFOLLOWERS_LIST);
        sessionStorage.removeItem(SK_UNFOLLOWERS_COUNT);
        sessionStorage.removeItem(SK_UNFOLLOWERS_READY);
        sessionStorage.setItem(SK_USER_ID, String(userId));
        sessionStorage.setItem(SK_USER_NAME, username);
        this.log('Logged in as @' + username);
        this.log('Following (count): ' + followingCount);
        this.log('Followers (count): ' + followersCount);
        sessionStorage.setItem(SK_COUNT_FOLLOWING, String(followingCount));
        sessionStorage.setItem(SK_COUNT_FOLLOWERS, String(followersCount));
        this.setResult({
            ok: true,
            command: 'counts',
            username,
            userId: String(userId),
            followingCount,
            followersCount,
        });
    }

    async requireLoggedInUser() {
        const { data, res } = await this.getJson('/api/v1/accounts/current_user/');
        if (res.ok) {
            const user = this.extractSessionUserFromPayload(data);
            if (user) return user;
            if (data.message === 'login_required' || data.require_login) {
                throw new Error('Instagram says login is required — reload instagram.com, sign in, then try Refresh counts again.');
            }
            if (data.status === 'fail') {
                throw new Error(
                    (data.message || 'Instagram API refused current_user.') +
                        ' Reload the tab or wait a few minutes if you were rate-limited.',
                );
            }
        }
        const fromForm = await this.tryEditWebFormUser();
        if (fromForm) return fromForm;
        if (!res.ok) {
            const msg =
                (data && (data.message || data.error)) ||
                'Instagram rejected the request';
            throw new Error(
                msg +
                    ' (HTTP ' +
                    res.status +
                    '). Reload the extension on chrome://extensions, hard-refresh instagram.com, and disable extensions that change the User-Agent or request headers.',
            );
        }
        const snippet = JSON.stringify(data).slice(0, 320);
        throw new Error(
            'Could not read your account from Instagram APIs (you may still be logged in in the UI). ' +
                'Try: hard-refresh instagram.com (Ctrl+Shift+R), stay on www.instagram.com, then Refresh counts. ' +
                'Debug: current_user → ' +
                snippet,
        );
    }

    async getJson(path, options = {}) {
        const res = await this.apiFetch(path, options);
        const text = await res.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch {
            throw new Error(`Not logged in or unexpected response (${res.status}). Sign in on Instagram in this tab.`);
        }
        return { res, data };
    }

    async apiFetch(path, options = {}) {
        const url = path.startsWith('http') ? path : ORIGIN + path;
        await this.waitForRateLimit();
        const { headers: extraHeaders, ...fetchOpts } = options;
        const headers = await this.buildIgHeaders(extraHeaders);
        return fetch(url, { credentials: 'include', ...fetchOpts, headers });
    }

    async waitForRateLimit() {
        const now = Date.now();
        this._requestTimes = this._requestTimes.filter((t) => now - t < 60_000);
        while (this._requestTimes.length >= MAX_PER_MIN) {
            this.throwIfCancelled();
            await this.interruptibleSleep(1000);
            const n = Date.now();
            this._requestTimes = this._requestTimes.filter((t) => n - t < 60_000);
        }
        if (this._requestTimes.length > 0) {
            const elapsed = now - this._requestTimes[this._requestTimes.length - 1];
            if (elapsed < MIN_GAP_MS) await this.interruptibleSleep(MIN_GAP_MS - elapsed);
        }
        this._requestTimes.push(Date.now());
    }

    async interruptibleSleep(ms, onTick) {
        const step = 400;
        let left = ms;
        while (left > 0) {
            this.throwIfCancelled();
            if (onTick) onTick();
            const t = Math.min(step, left);
            await this.sleep(t);
            left -= t;
        }
    }

    sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    randomBetween(a, b) {
        return a + Math.random() * (b - a);
    }

    throwIfCancelled() {
        if (sessionStorage.getItem(SK_CANCEL) === '1') {
            const err = new Error('Stopped by user');
            err.name = 'UserCancelled';
            throw err;
        }
    }

    async buildIgHeaders(extraHeaders) {
        const igAppId = await this.fetchIgAppId();
        const csrf = this.getCsrfToken();
        if (!csrf) {
            throw new Error(
                'No CSRF token found (cookie or meta). Reload instagram.com, stay on the main site (www), then try again.',
            );
        }
        const h = {
            'x-requested-with': 'XMLHttpRequest',
            accept: '*/*',
            'x-csrftoken': csrf,
            'x-ig-app-id': igAppId,
            ...(extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {}),
        };
        if (this._asbdId) h['x-asbd-id'] = this._asbdId;
        return h;
    }

    async fetchIgAppId() {
        if (this._igAppId) return this._igAppId;
        await this.waitForRateLimit();
        const res = await fetch(ORIGIN + '/', { credentials: 'include' });
        const text = await res.text();
        const m = text.match(/X-IG-App-ID":"(.*?)"/);
        if (!m) throw new Error('Could not find X-IG-App-ID on instagram.com homepage');
        this._igAppId = m[1];
        const asbd =
            text.match(/"ASBD_ID":"(\d+)"/) ||
            text.match(/ASBD_ID\\":\\"(\d+)\\"/) ||
            text.match(/"asbd_id":"(\d+)"/i);
        if (asbd) this._asbdId = asbd[1];
        return this._igAppId;
    }

    getCookie(name) {
        const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1') + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : '';
    }

    getCsrfToken() {
        const fromCookie = this.getCookie('csrftoken');
        if (fromCookie) return fromCookie;
        try {
            const meta = document.querySelector('meta[name="csrf-token"]');
            return meta ? meta.getAttribute('content') || '' : '';
        } catch {
            return '';
        }
    }

    normalizeSessionUser(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const pk = raw.pk != null ? raw.pk : raw.id != null ? raw.id : raw.user_id != null ? raw.user_id : raw.pk_id;
        if (pk == null && !raw.username) return null;
        const username = raw.username || raw.unique_username || '';
        return { ...raw, pk, username };
    }

    extractSessionUserFromPayload(data) {
        if (!data || typeof data !== 'object') return null;
        const candidates = [
            data.user,
            data.logged_in_user,
            data.viewer,
            data.data && data.data.user,
            data.data && data.data.viewer,
        ];
        for (const c of candidates) {
            const u = this.normalizeSessionUser(c);
            if (u && u.username && u.pk != null) return u;
        }
        for (const c of candidates) {
            const u = this.normalizeSessionUser(c);
            if (u && u.pk != null) return u;
        }
        for (const c of candidates) {
            const u = this.normalizeSessionUser(c);
            if (u && u.username) return u;
        }
        return null;
    }

    async tryEditWebFormUser() {
        let formUsername = '';
        let formPk = null;
        try {
            const r2 = await this.getJson('/api/v1/accounts/edit/web_form_data/');
            if (!r2.res.ok) return null;
            const fd = r2.data.form_data || r2.data;
            if (fd && typeof fd === 'object') {
                formUsername = fd.username || fd.unique_username || '';
                formPk = fd.pk != null ? fd.pk : fd.id != null ? fd.id : fd.user_id;
            }
        } catch {
            return null;
        }
        if (!formUsername) return null;
        return this.normalizeSessionUser({ username: formUsername, pk: formPk });
    }

    async getWebProfile(username) {
        const { data } = await this.getJson('/api/v1/users/web_profile_info/?username=' + encodeURIComponent(username));
        if (!data.data || !data.data.user) throw new Error('web_profile_info failed for ' + username);
        return data.data.user;
    }

    async runLoadUnfollowers() {
        try {
            const userId = sessionStorage.getItem(SK_USER_ID);
            if (!userId) throw new Error('Load profile first (Refresh counts) before loading unfollowers.');
            this.setLoadProgress({
                job: 'load',
                list: 'following',
                loaded: 0,
                page: 0,
                step: 'starting',
                detail: 'Starting following list',
            });
            this.log('Loading following…');
            const following = await this.paginateFriendships('/api/v1/friendships/' + userId + '/following/', 'following');
            this.log('Following loaded: ' + following.length + ' accounts');
            this.throwIfCancelled();
            this.setLoadProgress({
                list: 'followers',
                loaded: 0,
                page: 0,
                step: 'starting',
                detail: 'Starting followers list',
            });
            this.log('Loading followers…');
            const followers = await this.paginateFriendships(
                '/api/v1/friendships/' + userId + '/followers/?count=' + FRIENDSHIP_PAGE_COUNT,
                'followers',
            );
            this.log('Followers loaded: ' + followers.length + ' accounts');
            this.setLoadProgress({
                list: 'both',
                loaded: following.length + followers.length,
                page: 0,
                step: 'computing',
                detail: 'Comparing following vs followers',
            });
            const targets = this.notFollowingBack(following, followers);
            this.log('People you follow who do not follow you back: ' + targets.length);
            targets.forEach((u) => this.log('  @' + u.username));
            try {
                sessionStorage.setItem(SK_UNFOLLOWERS_LIST, JSON.stringify(targets));
                sessionStorage.setItem(SK_UNFOLLOWERS_COUNT, String(targets.length));
                sessionStorage.setItem(SK_UNFOLLOWERS_READY, '1');
            } catch (e) {
                if (e && e.name === 'QuotaExceededError') {
                    throw new Error('Browser storage full — unfollower list too large for sessionStorage.');
                }
                throw e;
            }
            this.setResult({
                ok: true,
                command: 'load_unfollowers',
                unfollowersCount: targets.length,
            });
        } finally {
            this.clearLoadProgress();
        }
    }

    async paginateFriendships(pathBase, listKind) {
        const users = [];
        let page = 0;
        this.setLoadProgress({
            list: listKind,
            loaded: 0,
            page: 0,
            step: 'between_pages',
            detail: 'Short pause before first page',
        });
        await this.interruptibleSleep(this.randomBetween(1000, 3000), () => this.bumpLoadProgress());
        page = 1;
        this.setLoadProgress({
            list: listKind,
            loaded: 0,
            page: 1,
            step: 'http_in_flight',
            detail: 'Fetching page 1 from Instagram',
        });
        let data = await this.getFriendshipPage(pathBase);
        users.push(...(data.users || []));
        this.setLoadProgress({
            list: listKind,
            loaded: users.length,
            page: 1,
            step: 'page_done',
            detail: 'Page 1 loaded',
        });
        this.log('  … ' + users.length + ' accounts loaded');
        while (data.next_max_id) {
            this.throwIfCancelled();
            this.setLoadProgress({
                list: listKind,
                loaded: users.length,
                page,
                step: 'between_pages',
                detail: 'Pause before next page (rate limiting)',
            });
            await this.interruptibleSleep(this.randomBetween(PAGINATION_MIN, PAGINATION_MAX), () => this.bumpLoadProgress());
            page++;
            const sep = pathBase.includes('?') ? '&' : '?';
            const url = pathBase + sep + 'max_id=' + encodeURIComponent(data.next_max_id);
            this.setLoadProgress({
                list: listKind,
                loaded: users.length,
                page,
                step: 'http_in_flight',
                detail: 'Fetching page ' + page,
            });
            data = await this.getFriendshipPage(url);
            users.push(...(data.users || []));
            this.setLoadProgress({
                list: listKind,
                loaded: users.length,
                page,
                step: 'page_done',
                detail: 'Page ' + page + ' loaded',
            });
            this.log('  … ' + users.length + ' accounts loaded');
        }
        return users;
    }

    async getFriendshipPage(pathWithQuery) {
        const maxAttempts = 30;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            this.throwIfCancelled();
            this.bumpLoadProgress();
            const { data, res } = await this.getJson(pathWithQuery);
            this.bumpLoadProgress();
            if (!res.ok) {
                this.log('Friendship HTTP ' + res.status + ', backing off 10m… (attempt ' + (attempt + 1) + '/' + maxAttempts + ')');
                this.setLoadProgress({
                    step: 'rate_limit_backoff',
                    detail: 'HTTP ' + res.status + ' — waiting ~10 min, retry ' + (attempt + 1) + '/' + maxAttempts,
                    backoffAttempt: attempt + 1,
                    backoffMax: maxAttempts,
                });
                await this.interruptibleSleep(RATE_LIMIT_MS, () => this.bumpLoadProgress());
                continue;
            }
            if (data && data.status === 'ok') return data;
            const msg = (data && (data.message || data.status)) || 'unknown response';
            this.log('Friendship API not ok (' + msg + '), backing off 10m… (attempt ' + (attempt + 1) + '/' + maxAttempts + ')');
            this.setLoadProgress({
                step: 'rate_limit_backoff',
                detail: 'API: ' + msg + ' — waiting ~10 min, retry ' + (attempt + 1) + '/' + maxAttempts,
                backoffAttempt: attempt + 1,
                backoffMax: maxAttempts,
            });
            await this.interruptibleSleep(RATE_LIMIT_MS, () => this.bumpLoadProgress());
        }
        throw new Error('Friendship API: still not ok after ' + maxAttempts + ' waits');
    }

    notFollowingBack(following, followers) {
        const followerNames = new Set(followers.map((u) => u.username));
        return following.filter((u) => !followerNames.has(u.username));
    }

    async runUnfollow(whitelistUsernames) {
        if (sessionStorage.getItem(SK_UNFOLLOWERS_READY) !== '1') {
            throw new Error('Run “Load Unfollowers” first to build the cache.');
        }
        let targets;
        try {
            targets = JSON.parse(sessionStorage.getItem(SK_UNFOLLOWERS_LIST) || '[]');
        } catch {
            throw new Error('Could not read cached unfollowers — load unfollowers again.');
        }
        if (!Array.isArray(targets)) {
            throw new Error('Invalid unfollowers cache — load unfollowers again.');
        }
        const whitelistSet = new Set(
            whitelistUsernames
                .map((s) => (typeof s === 'string' ? s.trim().replace(/^@+/, '').toLowerCase() : ''))
                .filter(Boolean),
        );
        this.log('Unfollowing from cache: ' + targets.length + ' account(s)');
        targets.forEach((u) => this.log('  @' + u.username));
        let skippedWhitelist = 0;
        let unfollowed = 0;
        let failed = 0;
        const total = targets.length;
        try {
            this.setLoadProgress({
                job: 'unfollow',
                total,
                current: 0,
                cacheRemaining: this.countUnfollowersInCache(),
                step: 'starting',
                detail: 'Starting unfollow run',
            });
            for (let i = 0; i < targets.length; i++) {
                const u = targets[i];
                const current = i + 1;
                this.throwIfCancelled();
                this.setLoadProgress({
                    job: 'unfollow',
                    total,
                    current,
                    activeUser: u.username,
                    cacheRemaining: this.countUnfollowersInCache(),
                    step: 'account',
                    detail: 'Account ' + current + ' of ' + total,
                });
                const uname = u && u.username != null ? String(u.username).trim().replace(/^@+/, '').toLowerCase() : '';
                if (uname && whitelistSet.has(uname)) {
                    this.log('Skip whitelist @' + u.username);
                    skippedWhitelist++;
                    this.setLoadProgress({
                        job: 'unfollow',
                        total,
                        current,
                        activeUser: u.username,
                        cacheRemaining: this.countUnfollowersInCache(),
                        step: 'skipped_whitelist',
                        detail: 'Skipped (whitelist)',
                    });
                    continue;
                }
                const ok = await this.unfollowOne(u, current, total);
                if (ok) unfollowed++;
                else failed++;
                this.setLoadProgress({
                    job: 'unfollow',
                    total,
                    current,
                    activeUser: u.username,
                    cacheRemaining: this.countUnfollowersInCache(),
                    step: ok ? 'done_user' : 'failed_user',
                    detail: ok ? 'Unfollowed @' + u.username : 'Failed or skipped @' + u.username,
                });
                if (!ok) await this.interruptibleSleep(this.randomBetween(45_000, 120_000), () => this.bumpLoadProgress());
            }
            this.setResult({
                ok: true,
                command: 'unfollow',
                summary: { targets: targets.length, skippedWhitelist, unfollowed, failed },
            });
            this.log('Done.');
        } catch (e) {
            if (e && e.name === 'UserCancelled') {
                this.log('Stopped by user.');
                this.setResult({
                    ok: false,
                    cancelled: true,
                    command: 'unfollow',
                    summary: { targets: targets.length, skippedWhitelist, unfollowed, failed },
                });
                this.log('Done.');
                return;
            }
            throw e;
        } finally {
            this.clearLoadProgress();
        }
    }

    async unfollowOne(user, current, total) {
        const baseProgress = () => ({
            job: 'unfollow',
            total,
            current,
            activeUser: user.username,
            cacheRemaining: this.countUnfollowersInCache(),
        });
        this.setLoadProgress({
            ...baseProgress(),
            step: 'delay_before',
            detail: 'Pause before profile request',
        });
        await this.interruptibleSleep(this.randomBetween(UNFOLLOW_MIN, UNFOLLOW_MAX), () => this.bumpLoadProgress());
        this.setLoadProgress({
            ...baseProgress(),
            step: 'fetch_profile',
            detail: 'Loading profile page',
        });
        const pageRes = await this.apiFetch(ORIGIN + '/' + user.username + '/', { method: 'GET' });
        const html = await pageRes.text();
        this.bumpLoadProgress();
        const csrfMatch =
            html.match(/"csrf_token":"([^"]+)"/) ||
            html.match(/csrf_token\\":\\"(.*?)\\"/);
        this.setLoadProgress({
            ...baseProgress(),
            step: 'delay_before_post',
            detail: 'Pause before unfollow request',
        });
        await this.interruptibleSleep(this.randomBetween(BETWEEN_PAGE_UNFOLLOW_MIN, BETWEEN_PAGE_UNFOLLOW_MAX), () =>
            this.bumpLoadProgress(),
        );
        const csrf = csrfMatch ? csrfMatch[1] : this.getCsrfToken();
        this.setLoadProgress({
            ...baseProgress(),
            step: 'rate_limit',
            detail: 'Spacing API calls',
        });
        await this.waitForRateLimit();
        this.bumpLoadProgress();
        const unfollowHeaders = await this.buildIgHeaders({
            referer: ORIGIN + '/' + user.username + '/',
            'x-csrftoken': csrf,
        });
        const friendshipId = user.pk != null ? user.pk : user.id;
        this.setLoadProgress({
            ...baseProgress(),
            step: 'unfollow_post',
            detail: 'Sending unfollow',
        });
        const res = await fetch(ORIGIN + '/web/friendships/' + friendshipId + '/unfollow/', {
            method: 'POST',
            credentials: 'include',
            headers: unfollowHeaders,
        });
        this.bumpLoadProgress();
        if (res.status === 429) {
            this.log('429 on unfollow ' + user.username + ' — wait and retry later');
            return false;
        }
        let body;
        try {
            body = JSON.parse(await res.text());
        } catch {
            return false;
        }
        if (body.status !== 'ok') {
            this.log('Unfollow failed ' + user.username + ': ' + JSON.stringify(body).slice(0, 200));
            return false;
        }
        this.removeUserFromUnfollowersCache(user);
        this.log('Unfollowed ' + user.username);
        return true;
    }
}

(function bootstrapInstaUnfollowRunner() {
    new InstaUnfollowRunner().main();
})();
