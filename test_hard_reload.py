#!/usr/bin/env python3
"""Test with hard reload and cache clearing"""

from playwright.sync_api import sync_playwright
import time

def test():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={'width': 1920, 'height': 1080},
            bypass_csp=True
        )
        
        page = context.new_page()
        
        # Force hard reload by adding unique timestamp
        ts = str(int(time.time() * 1000))
        page.goto(f'https://pi.letsautomate.work?nocache={ts}', wait_until='networkidle')
        
        # Clear storage
        page.evaluate('() => { localStorage.clear(); sessionStorage.clear(); }')
        
        page.locator('input[type="password"]').fill('Ey@U1U%d5D77J99F')
        page.locator('button[type="submit"]').click()
        page.wait_for_load_state('networkidle')
        time.sleep(3)
        
        # Create new session
        page.get_by_text('Create new session').first.click()
        time.sleep(2)
        page.get_by_text('Create Session').first.click()
        time.sleep(3)
        
        # Send slash command
        page.locator('textarea').first.fill('/skill:lecture-website test')
        page.keyboard.press('Control+Enter')
        time.sleep(12)
        
        html = page.content()
        
        # Check patterns
        patterns = ['<skill name="', '</skill>', 'Lecture Website Builder', '## Process']
        found = [p for p in patterns if p in html]
        
        print(f"Patterns found: {len(found)}")
        for p in found:
            print(f"  - {p}")
        
        page.screenshot(path='/tmp/hard_reload_test.png', full_page=True)
        print(f"Screenshot: /tmp/hard_reload_test.png")
        
        browser.close()
        return len(found) == 0

if __name__ == '__main__':
    import sys
    success = test()
    sys.exit(0 if success else 1)
