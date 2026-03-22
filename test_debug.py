#!/usr/bin/env python3
"""Debug test to see actual message content"""

from playwright.sync_api import sync_playwright
import time

def test_debug():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = context.new_page()
        
        page.goto('https://pi.letsautomate.work', wait_until='networkidle')
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
        time.sleep(10)
        
        # Get HTML and look for message structure
        html = page.content()
        
        # Look for message data
        if '<skill' in html.lower():
            idx = html.lower().find('<skill')
            snippet = html[max(0,idx-200):idx+300]
            print("Found skill tag in HTML:")
            print(snippet[:500])
        
        # Check for assistant message content
        # Look for the actual text content in the DOM
        texts = page.locator('[class*="message"], [class*="bubble"], article, .prose').all_inner_texts()
        for i, text in enumerate(texts[:5]):
            print(f"\n--- Text block {i} ---")
            print(text[:500])
            if '<skill' in text.lower():
                print("  ^^^ Contains skill tag!")
        
        browser.close()

if __name__ == '__main__':
    test_debug()
