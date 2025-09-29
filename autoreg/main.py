import requests
import time
import json
import os
import random
import string
import threading
import argparse
import sys
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse
import queue

class BplaceAccountGenerator:
    def __init__(self):
        self.config_file = "config.json"
        self.proxies_file = "proxies.txt"
        self.config = self.load_config()
        self.proxies = self.load_proxies() if self.config.get('proxies', {}).get('enabled', False) else []
        self.proxy_queue = queue.Queue()
        self.success_count = 0
        self.failed_count = 0
        self.total_attempts = 0
        self.lock = threading.Lock()
        self.output_folder = None
        
        # Load proxies into queue if enabled
        if self.config.get('proxies', {}).get('enabled', False):
            for proxy in self.proxies:
                self.proxy_queue.put(proxy)
            print(f"[PROXY] Proxy system enabled with {len(self.proxies)} proxies")
        else:
            print("[PROXY] Proxy system disabled")
    
    def load_config(self):
        """Load configuration or create default if it doesn't exist"""
        default_config = {
            "_comments": {
                "site": "Target website configuration",
                "captcha_api": "Local captcha solver API settings",
                "generation": "Account generation settings",
                "proxies": "Proxy configuration",
                "retry": "Retry and failure handling settings",
                "output": "File output settings",
                "browser": "Browser headers and user agent"
            },
            "site": {
                "url": "https://bplace.org",
                "sitekey": "0x4AAAAAABzxJUknzE7fFeq5"
            },
            "captcha_api": {
                "base_url": "http://localhost:8080",
                "timeout": 10,
                "poll_interval": 3
            },
            "generation": {
                "username_prefix": "user",
                "username_random_length": 12,
                "password_mode": "random",
                "_password_modes": "Available modes: 'random', 'static'",
                "static_password": "Password123!",
                "password_length": 15,
                "password_chars": "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*",
                "threads": 5,
                "thread_delay": 0.5
            },
            "proxies": {
                "enabled": False,
                "_proxy_note": "Set enabled to true and add proxies to proxies.txt file",
                "rotation_mode": "sequential",
                "_rotation_modes": "Available modes: 'sequential', 'random'",
                "retry_failed_proxy": True,
                "proxy_timeout": 30
            },
            "retry": {
                "enabled": True,
                "max_retries_per_account": 3,
                "retry_delay": 2,
                "max_total_attempts": 150,
                "_retry_note": "If target is 100 accounts but some fail, it will retry up to max_total_attempts (150) to reach the target"
            },
            "output": {
                "save_cookies": True,
                "save_accounts": True,
                "save_failed_attempts": False,
                "verbose_logging": True
            },
            "browser": {
                "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
                "accept_language": "en-GB,en;q=0.7"
            }
        }
        
        if not os.path.exists(self.config_file):
            print(f"[CONFIG] Creating default config file: {self.config_file}")
            with open(self.config_file, 'w', encoding='utf-8') as f:
                json.dump(default_config, f, indent=4)
            return default_config
        
        try:
            with open(self.config_file, 'r', encoding='utf-8') as f:
                config = json.load(f)
            print(f"[CONFIG] Loaded config from: {self.config_file}")
            return config
        except Exception as e:
            print(f"[ERROR] Failed to load config: {e}")
            return default_config
    
    def load_proxies(self):
        """Load proxies from file or create empty file"""
        if not os.path.exists(self.proxies_file):
            print(f"[PROXY] Creating empty proxy file: {self.proxies_file}")
            with open(self.proxies_file, 'w', encoding='utf-8') as f:
                f.write("# Proxy format examples:\n")
                f.write("# HTTP: http://proxy_ip:port\n")
                f.write("# HTTP with auth: http://username:password@proxy_ip:port\n")
                f.write("# SOCKS4: socks4://proxy_ip:port\n")
                f.write("# SOCKS5: socks5://proxy_ip:port\n")
                f.write("# SOCKS5 with auth: socks5://username:password@proxy_ip:port\n")
            return []
        
        proxies = []
        try:
            with open(self.proxies_file, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#'):
                        proxies.append(line)
            print(f"[PROXY] Loaded {len(proxies)} proxies from: {self.proxies_file}")
            return proxies
        except Exception as e:
            print(f"[ERROR] Failed to load proxies: {e}")
            return []
    
    def generate_username(self):
        """Generate random username with prefix"""
        prefix = self.config['generation']['username_prefix']
        # Use username_random_length for the random part only
        random_length = self.config['generation'].get('username_random_length', 12)
        if random_length <= 0:
            random_length = 8
        
        suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=random_length))
        return prefix + suffix
    
    def generate_password(self):
        """Generate password based on config"""
        if self.config['generation']['password_mode'] == 'static':
            return self.config['generation']['static_password']
        
        length = self.config['generation']['password_length']
        chars = self.config['generation'].get('password_chars', string.ascii_letters + string.digits + "!@#$%^&*")
        return ''.join(random.choices(chars, k=length))
    
    def get_proxy(self):
        """Get next proxy from queue, return to queue when done"""
        if not self.config.get('proxies', {}).get('enabled', False) or self.proxy_queue.empty():
            return None
        
        rotation_mode = self.config.get('proxies', {}).get('rotation_mode', 'sequential')
        if rotation_mode == 'random':
            # For random mode, we need to get all proxies and choose randomly
            temp_proxies = []
            while not self.proxy_queue.empty():
                temp_proxies.append(self.proxy_queue.get())
            
            if temp_proxies:
                chosen_proxy = random.choice(temp_proxies)
                # Put back all proxies except the chosen one
                for proxy in temp_proxies:
                    if proxy != chosen_proxy:
                        self.proxy_queue.put(proxy)
                return chosen_proxy
            return None
        else:
            # Sequential mode (default)
            return self.proxy_queue.get()
    
    def return_proxy(self, proxy):
        """Return proxy to queue for reuse"""
        if proxy and self.config.get('proxies', {}).get('enabled', False):
            self.proxy_queue.put(proxy)
    
    def parse_proxy(self, proxy_string):
        """Parse proxy string into requests format"""
        if not proxy_string:
            return None
            
        try:
            parsed = urlparse(proxy_string)
            if parsed.scheme in ['http', 'https']:
                return {
                    'http': proxy_string,
                    'https': proxy_string
                }
            elif parsed.scheme in ['socks4', 'socks5']:
                return {
                    'http': proxy_string,
                    'https': proxy_string
                }
            else:
                # Assume http if no scheme
                proxy_string = 'http://' + proxy_string
                return {
                    'http': proxy_string,
                    'https': proxy_string
                }
        except Exception as e:
            print(f"[ERROR] Failed to parse proxy {proxy_string}: {e}")
            return None
    
    def solve_captcha(self):
        """Solve Turnstile captcha using the local API server"""
        api_base_url = self.config['captcha_api']['base_url']
        url = self.config['site']['url']
        sitekey = self.config['site']['sitekey']
        timeout = self.config['captcha_api'].get('timeout', 10)
        poll_interval = self.config['captcha_api'].get('poll_interval', 3)
        
        params = {
            'url': url,
            'sitekey': sitekey
        }
        
        try:
            response = requests.get(f"{api_base_url}/turnstile", params=params, timeout=timeout)
            
            if response.status_code == 202:
                task_data = response.json()
                task_id = task_data.get('task_id')
                
                # Poll for results
                max_attempts = 60
                for attempt in range(max_attempts):
                    time.sleep(poll_interval)
                    
                    result_response = requests.get(f"{api_base_url}/result", 
                                                 params={'id': task_id}, timeout=timeout)
                    
                    if result_response.status_code == 202:
                        continue
                    elif result_response.status_code == 200:
                        result = result_response.json()
                        return result.get('value')
                    else:
                        return None
                
                return None
            else:
                return None
                
        except Exception as e:
            if self.config.get('output', {}).get('verbose_logging', True):
                print(f"[ERROR] Captcha solving failed: {str(e)}")
            return None
    
    def register_user(self, username, password, thread_id, attempt=1):
        """Register a single user account with retry logic"""
        proxy = self.get_proxy()
        proxy_dict = self.parse_proxy(proxy) if proxy else None
        
        try:
            # Solve captcha
            captcha_token = self.solve_captcha()
            if not captcha_token:
                if self.config.get('output', {}).get('verbose_logging', True):
                    print(f"[T{thread_id}] [{username}] (Attempt {attempt}) Failed to solve captcha")
                return None
            
            # Prepare session with simplified headers
            session = requests.Session()
            if proxy_dict:
                session.proxies.update(proxy_dict)
                
            # Set basic headers
            headers = {
                'authority': 'bplace.org',
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'accept-encoding': 'gzip, deflate, br, zstd',
                'accept-language': self.config.get('browser', {}).get('accept_language', 'en-GB,en;q=0.7'),
                'cache-control': 'max-age=0',
                'content-type': 'application/x-www-form-urlencoded',
                'origin': 'https://bplace.org',
                'priority': 'u=0, i',
                'referer': 'https://bplace.org/login',
                'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Brave";v="140"',
                'sec-ch-ua-arch': '"x86"',
                'sec-ch-ua-bitness': '"64"',
                'sec-ch-ua-full-version-list': '"Chromium";v="140.0.0.0", "Not=A?Brand";v="24.0.0.0", "Brave";v="140.0.0.0"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-model': '""',
                'sec-ch-ua-platform': '"Windows"',
                'sec-ch-ua-platform-version': '"19.0.0"',
                'sec-fetch-dest': 'document',
                'sec-fetch-mode': 'navigate',
                'sec-fetch-site': 'same-origin',
                'sec-fetch-user': '?1',
                'sec-gpc': '1',
                'upgrade-insecure-requests': '1',
                'user-agent': self.config.get('browser', {}).get('user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')
            }
            session.headers.update(headers)
            
            data = {
                'username': username,
                'password': password,
                'confirm': password,
                'cf-turnstile-response': captcha_token
            }
            
            # Register account
            proxy_timeout = self.config.get('proxies', {}).get('proxy_timeout', 30)
            req = session.post('https://bplace.org/account/register', 
                             data=data, allow_redirects=False, timeout=proxy_timeout)
            
            # Check for success
            j_cookie = None
            for cookie in req.cookies:
                if cookie.name == 'j':
                    j_cookie = cookie.value
                    break
            
            # Check Set-Cookie headers
            if not j_cookie and 'Set-Cookie' in req.headers:
                set_cookie_header = req.headers['Set-Cookie']
                if 'j=' in set_cookie_header:
                    j_start = set_cookie_header.find('j=') + 2
                    j_end = set_cookie_header.find(';', j_start)
                    if j_end == -1:
                        j_end = len(set_cookie_header)
                    j_cookie = set_cookie_header[j_start:j_end]
            
            with self.lock:
                self.total_attempts += 1
            
            if req.status_code == 302 and j_cookie:
                print(f"[T{thread_id}] [SUCCESS] {username} - Account created! (Attempt {attempt})")
                with self.lock:
                    self.success_count += 1
                return {
                    'username': username,
                    'password': password,
                    'cookie': j_cookie,
                    'success': True
                }
            else:
                redirect_url = req.headers.get('Location', '')
                if 'error=' in redirect_url.lower():
                    if 'Username+already+taken' in redirect_url:
                        if self.config.get('output', {}).get('verbose_logging', True):
                            print(f"[T{thread_id}] [FAILED] {username} - Username taken (Attempt {attempt})")
                    else:
                        if self.config.get('output', {}).get('verbose_logging', True):
                            print(f"[T{thread_id}] [FAILED] {username} - Registration error (Attempt {attempt})")
                else:
                    if self.config.get('output', {}).get('verbose_logging', True):
                        print(f"[T{thread_id}] [FAILED] {username} - Unknown error HTTP {req.status_code} (Attempt {attempt})")
                
                with self.lock:
                    self.failed_count += 1
                return None
                
        except Exception as e:
            if self.config.get('output', {}).get('verbose_logging', True):
                print(f"[T{thread_id}] [ERROR] {username} - {str(e)} (Attempt {attempt})")
            with self.lock:
                self.failed_count += 1
            return None
        finally:
            self.return_proxy(proxy)
    
    def create_output_folder(self):
        """Create output folder with timestamp"""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        folder_name = f"accounts_{timestamp}"
        os.makedirs(folder_name, exist_ok=True)
        self.output_folder = folder_name
        print(f"[OUTPUT] Created folder: {folder_name}")
        return folder_name
    
    def save_account(self, account_data):
        """Save successful account to files"""
        if not account_data or not account_data['success']:
            return
        
        # Save to accounts file
        accounts_file = os.path.join(self.output_folder, "accounts.txt")
        with open(accounts_file, 'a', encoding='utf-8') as f:
            f.write(f"{account_data['username']}:{account_data['password']}\n")
        
        # Save to cookies file
        cookies_file = os.path.join(self.output_folder, "cookies.txt")
        with open(cookies_file, 'a', encoding='utf-8') as f:
            f.write(f"{account_data['cookie']}\n")
    
    def generate_accounts(self, target_count):
        """Generate specified number of accounts using threading with retry system"""
        print(f"\n[GENERATOR] Starting generation of {target_count} accounts")
        print(f"[GENERATOR] Using {self.config['generation']['threads']} threads")
        print(f"[GENERATOR] Proxies: {'Enabled' if self.config.get('proxies', {}).get('enabled', False) else 'Disabled'}")
        if self.config.get('proxies', {}).get('enabled', False):
            print(f"[GENERATOR] Proxies available: {len(self.proxies)}")
        
        retry_enabled = self.config.get('retry', {}).get('enabled', True)
        max_retries = self.config.get('retry', {}).get('max_retries_per_account', 3)
        max_total_attempts = self.config.get('retry', {}).get('max_total_attempts', target_count * 2)
        retry_delay = self.config.get('retry', {}).get('retry_delay', 2)
        thread_delay = self.config.get('generation', {}).get('thread_delay', 0.5)
        
        if retry_enabled:
            print(f"[GENERATOR] Retry system enabled - Max {max_retries} retries per account")
            print(f"[GENERATOR] Will stop at {max_total_attempts} total attempts to prevent infinite loops")
        
        self.create_output_folder()
        
        thread_pool = ThreadPoolExecutor(max_workers=self.config['generation']['threads'])
        
        while self.success_count < target_count and self.total_attempts < max_total_attempts:
            remaining_needed = target_count - self.success_count
            batch_size = min(remaining_needed * 2, self.config['generation']['threads'] * 3)  # Generate extra to account for failures
            
            futures = []
            
            # Submit batch of tasks
            for i in range(batch_size):
                if self.total_attempts >= max_total_attempts:
                    break
                    
                username = self.generate_username()
                password = self.generate_password()
                thread_id = (i % self.config['generation']['threads']) + 1
                
                future = thread_pool.submit(self.register_user, username, password, thread_id, 1)
                futures.append(future)
                
                # Add delay between thread starts
                if thread_delay > 0:
                    time.sleep(thread_delay)
            
            # Process completed tasks
            completed_batch = 0
            failed_accounts = []
            
            for future in as_completed(futures):
                try:
                    result = future.result()
                    if result and result.get('success'):
                        self.save_account(result)
                    else:
                        failed_accounts.append(future)
                    
                    completed_batch += 1
                    
                    # Progress update
                    if completed_batch % 3 == 0 or self.success_count >= target_count:
                        progress_pct = (self.success_count / target_count * 100)
                        print(f"[PROGRESS] Success: {self.success_count}/{target_count} ({progress_pct:.1f}%) | "
                              f"Total Attempts: {self.total_attempts} | Failed: {self.failed_count}")
                        
                        if self.success_count >= target_count:
                            break
                        
                except Exception as e:
                    if self.config.get('output', {}).get('verbose_logging', True):
                        print(f"[ERROR] Task failed: {e}")
                    completed_batch += 1
            
            # Retry logic for failed accounts
            if retry_enabled and failed_accounts and self.success_count < target_count:
                retry_futures = []
                
                for attempt in range(2, max_retries + 1):
                    if self.success_count >= target_count or self.total_attempts >= max_total_attempts:
                        break
                        
                    accounts_to_retry = min(len(failed_accounts), target_count - self.success_count)
                    
                    if accounts_to_retry > 0 and retry_delay > 0:
                        print(f"[RETRY] Waiting {retry_delay}s before retry attempt {attempt}...")
                        time.sleep(retry_delay)
                    
                    for i in range(accounts_to_retry):
                        if self.total_attempts >= max_total_attempts:
                            break
                            
                        username = self.generate_username()
                        password = self.generate_password()
                        thread_id = (i % self.config['generation']['threads']) + 1
                        
                        future = thread_pool.submit(self.register_user, username, password, thread_id, attempt)
                        retry_futures.append(future)
                    
                    # Process retry results
                    for future in as_completed(retry_futures):
                        try:
                            result = future.result()
                            if result and result.get('success'):
                                self.save_account(result)
                                if self.success_count >= target_count:
                                    break
                        except Exception as e:
                            if self.config.get('output', {}).get('verbose_logging', True):
                                print(f"[ERROR] Retry task failed: {e}")
                    
                    retry_futures.clear()
            
            # Check if we've reached our target
            if self.success_count >= target_count:
                print(f"[SUCCESS] Target of {target_count} accounts reached!")
                break
                
            # Check if we've hit the maximum attempts limit
            if self.total_attempts >= max_total_attempts:
                print(f"[WARNING] Maximum attempts ({max_total_attempts}) reached. Stopping generation.")
                break
        
        thread_pool.shutdown(wait=True)
        
        # Final results
        print(f"\n[RESULTS] Generation completed!")
        print(f"[RESULTS] Target: {target_count} accounts")
        print(f"[RESULTS] Successful: {self.success_count}")
        print(f"[RESULTS] Failed: {self.failed_count}")
        print(f"[RESULTS] Total attempts: {self.total_attempts}")
        print(f"[RESULTS] Success rate: {(self.success_count/self.total_attempts*100):.1f}%")
        print(f"[RESULTS] Target completion: {(self.success_count/target_count*100):.1f}%")
        print(f"[RESULTS] Output folder: {self.output_folder}")
        
        if self.success_count < target_count:
            shortage = target_count - self.success_count
            print(f"[WARNING] {shortage} accounts short of target. Consider:")
            print(f"          - Checking captcha solver status")
            print(f"          - Increasing max_total_attempts in config")
            print(f"          - Adding more/better proxies if enabled")
    
    def create_single_account(self, username, password):
        """Create a single account with specified credentials"""
        print(f"\n[CLI] Creating single account: {username}")
        
        self.create_output_folder()
        
        # Try to create the account with retries
        max_retries = self.config.get('retry', {}).get('max_retries_per_account', 3)
        retry_delay = self.config.get('retry', {}).get('retry_delay', 2)
        
        for attempt in range(1, max_retries + 1):
            print(f"[CLI] Attempt {attempt}/{max_retries} for {username}")
            
            result = self.register_user(username, password, 1, attempt)
            
            if result and result.get('success'):
                self.save_account(result)
                print(f"[CLI] SUCCESS! Account {username} created successfully!")
                print(f"[CLI] Cookie: {result['cookie'][:50]}...")
                print(f"[CLI] Saved to folder: {self.output_folder}")
                return True
            else:
                if attempt < max_retries:
                    print(f"[CLI] Failed attempt {attempt}, retrying in {retry_delay} seconds...")
                    time.sleep(retry_delay)
                else:
                    print(f"[CLI] FAILED! Could not create account {username} after {max_retries} attempts")
        
        return False
    
    def create_multiple_accounts(self, accounts_list):
        """Create multiple specific accounts from a list of username:password pairs"""
        print(f"\n[CLI] Creating {len(accounts_list)} specific accounts")
        
        self.create_output_folder()
        
        thread_pool = ThreadPoolExecutor(max_workers=self.config['generation']['threads'])
        futures = []
        thread_delay = self.config.get('generation', {}).get('thread_delay', 0.5)
        
        # Submit all tasks
        for i, (username, password) in enumerate(accounts_list):
            thread_id = (i % self.config['generation']['threads']) + 1
            future = thread_pool.submit(self.register_user, username, password, thread_id, 1)
            futures.append((future, username, password))
            
            # Add delay between thread starts
            if thread_delay > 0 and i < len(accounts_list) - 1:
                time.sleep(thread_delay)
        
        # Process results
        successful_accounts = []
        failed_accounts = []
        
        for future, username, password in futures:
            try:
                result = future.result()
                if result and result.get('success'):
                    self.save_account(result)
                    successful_accounts.append(username)
                    print(f"[CLI] SUCCESS: {username}")
                else:
                    failed_accounts.append((username, password))
                    print(f"[CLI] FAILED: {username}")
            except Exception as e:
                failed_accounts.append((username, password))
                print(f"[CLI] ERROR: {username} - {str(e)}")
        
        thread_pool.shutdown(wait=True)
        
        # Retry failed accounts if retry is enabled
        if failed_accounts and self.config.get('retry', {}).get('enabled', True):
            max_retries = self.config.get('retry', {}).get('max_retries_per_account', 3)
            retry_delay = self.config.get('retry', {}).get('retry_delay', 2)
            
            for attempt in range(2, max_retries + 1):
                if not failed_accounts:
                    break
                    
                print(f"\n[CLI] Retry attempt {attempt}/{max_retries} for {len(failed_accounts)} failed accounts")
                time.sleep(retry_delay)
                
                retry_pool = ThreadPoolExecutor(max_workers=self.config['generation']['threads'])
                retry_futures = []
                
                for i, (username, password) in enumerate(failed_accounts):
                    thread_id = (i % self.config['generation']['threads']) + 1
                    future = retry_pool.submit(self.register_user, username, password, thread_id, attempt)
                    retry_futures.append((future, username, password))
                
                # Process retry results
                still_failed = []
                for future, username, password in retry_futures:
                    try:
                        result = future.result()
                        if result and result.get('success'):
                            self.save_account(result)
                            successful_accounts.append(username)
                            print(f"[CLI] RETRY SUCCESS: {username}")
                        else:
                            still_failed.append((username, password))
                    except Exception as e:
                        still_failed.append((username, password))
                
                failed_accounts = still_failed
                retry_pool.shutdown(wait=True)
        
        # Final results
        print(f"\n[CLI] Results:")
        print(f"[CLI] Successful: {len(successful_accounts)}")
        print(f"[CLI] Failed: {len(failed_accounts)}")
        print(f"[CLI] Success rate: {(len(successful_accounts)/(len(successful_accounts)+len(failed_accounts))*100):.1f}%")
        print(f"[CLI] Output folder: {self.output_folder}")
        
        if failed_accounts:
            print(f"[CLI] Failed accounts: {[acc[0] for acc in failed_accounts]}")
        
        return len(successful_accounts)

def parse_arguments():
    """Parse command line arguments"""
    parser = argparse.ArgumentParser(
        description='Bplace Account Generator - Create accounts automatically',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  # Interactive mode (default)
  python main.py
  
  # Create single account
  python main.py --username myuser --password mypass123
  
  # Create multiple specific accounts
  python main.py --accounts user1:pass1 user2:pass2 user3:pass3
  
  # Generate random accounts
  python main.py --generate 10
  
  # Combine modes
  python main.py --username specific_user --password specific_pass --generate 5
        '''
    )
    
    parser.add_argument('--username', '-u', type=str, 
                       help='Username for single account creation')
    parser.add_argument('--password', '-p', type=str, 
                       help='Password for single account creation')
    parser.add_argument('--accounts', '-a', nargs='+', 
                       help='Multiple accounts in format username:password')
    parser.add_argument('--generate', '-g', type=int, 
                       help='Number of random accounts to generate')
    parser.add_argument('--config', '-c', type=str, default='config.json',
                       help='Config file path (default: config.json)')
    parser.add_argument('--quiet', '-q', action='store_true',
                       help='Reduce output verbosity')
    
    return parser.parse_args()

def main():
    args = parse_arguments()
    
    print("=" * 60)
    print("            BPLACE ACCOUNT GENERATOR")
    print("=" * 60)
    
    # Update config file path if specified
    generator = BplaceAccountGenerator()
    if args.config != 'config.json':
        generator.config_file = args.config
        generator.config = generator.load_config()
    
    # Set verbosity
    if args.quiet:
        generator.config['output']['verbose_logging'] = False
    
    # Check if any CLI arguments were provided
    cli_mode = any([args.username, args.accounts, args.generate])
    
    if not cli_mode:
        # Interactive mode
        print("\n[MODE] Interactive mode")
        try:
            target_count = int(input("\nHow many accounts to generate? "))
            if target_count <= 0:
                print("[ERROR] Please enter a positive number")
                return
        except ValueError:
            print("[ERROR] Please enter a valid number")
            return
        except KeyboardInterrupt:
            print("\n[INFO] Operation cancelled by user")
            return
        
        generator.generate_accounts(target_count)
        
    else:
        # CLI mode
        print("\n[MODE] Command-line mode")
        total_created = 0
        
        # Handle single account creation
        if args.username and args.password:
            print(f"\n[CLI] Single account mode")
            success = generator.create_single_account(args.username, args.password)
            if success:
                total_created += 1
        elif args.username or args.password:
            print("[ERROR] Both --username and --password are required for single account creation")
            return
        
        # Handle multiple specific accounts
        if args.accounts:
            print(f"\n[CLI] Multiple accounts mode")
            accounts_list = []
            
            for account in args.accounts:
                if ':' in account:
                    username, password = account.split(':', 1)
                    accounts_list.append((username, password))
                else:
                    print(f"[ERROR] Invalid account format: {account} (expected username:password)")
                    return
            
            if accounts_list:
                created = generator.create_multiple_accounts(accounts_list)
                total_created += created
        
        # Handle random account generation
        if args.generate:
            print(f"\n[CLI] Random generation mode")
            if args.generate <= 0:
                print("[ERROR] Generate count must be positive")
                return
            
            generator.generate_accounts(args.generate)
            total_created += generator.success_count
        
        # Final CLI summary
        if total_created > 0:
            print(f"\n[CLI] Total accounts created this session: {total_created}")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[INFO] Operation cancelled by user")
        sys.exit(0)
    except Exception as e:
        print(f"\n[ERROR] Unexpected error: {e}")
        sys.exit(1)