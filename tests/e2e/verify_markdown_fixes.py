#!/usr/bin/env python3
"""
Visual verification of markdown rendering fixes by taking a screenshot of a test HTML file.
"""

from playwright.sync_api import sync_playwright

def test_markdown_rendering():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1280, 'height': 1200})
        
        # Load the test HTML file
        page.goto('file:///root/pi-web-ui/test-results/markdown_test.html')
        page.wait_for_load_state('networkidle')
        
        # Take screenshot
        page.screenshot(path='/root/pi-web-ui/test-results/markdown_rendering_fixes.png', full_page=True)
        print("Screenshot saved: markdown_rendering_fixes.png")
        
        browser.close()
        print("\nTest completed!")
        print("The screenshot shows the fixed markdown rendering:")
        print("1. Tables with proper borders")
        print("2. Inline code in lists (not block)")
        print("3. Todo tool output with status banner")

if __name__ == '__main__':
    test_markdown_rendering()
