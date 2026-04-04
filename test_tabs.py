#!/usr/bin/env python3
"""Test Shell and Files tabs with Playwright"""

from playwright.sync_api import sync_playwright
import time
import sys

def test_tabs():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1280, 'height': 800})
        
        # Collect console errors
        console_errors = []
        page.on('console', lambda msg: console_errors.append(msg.text) if msg.type == 'error' else None)
        
        print("1. Navigating to login page...")
        page.goto('http://localhost:3456')
        page.wait_for_load_state('networkidle')
        time.sleep(1)
        
        # Login
        print("2. Logging in...")
        password_input = page.locator('input[type="password"]')
        if password_input.is_visible():
            password_input.fill('admin')
            page.locator('button[type="submit"]').click()
            time.sleep(2)
        
        # Wait for chat interface
        print("3. Waiting for chat interface...")
        page.wait_for_selector('[data-testid="chat-interface"]', timeout=10000)
        print("   ✓ Chat interface loaded")
        
        # Check for tabs
        print("4. Checking for tab navigation...")
        shell_tab = page.locator('button').filter(has_text='Shell').first
        files_tab = page.locator('button').filter(has_text='Files').first
        
        # Test Shell tab
        print("5. Testing Shell tab...")
        if shell_tab.is_visible():
            shell_tab.click()
            time.sleep(1)
            
            # Take screenshot of shell
            page.screenshot(path='/tmp/shell_tab.png', full_page=False)
            print("   ✓ Shell tab screenshot saved to /tmp/shell_tab.png")
            
            # Check for disconnected status
            page_content = page.content()
            if 'Disconnected' in page_content:
                print("   ⚠ Shell shows 'Disconnected' - terminal may not be working")
            elif 'Connected' in page_content:
                print("   ✓ Shell shows 'Connected'")
            else:
                print("   ? Shell status unclear")
        else:
            print("   ✗ Shell tab not found")
        
        # Test Files tab
        print("6. Testing Files tab...")
        if files_tab.is_visible():
            files_tab.click()
            time.sleep(1.5)  # Wait for files to load
            
            # Take screenshot of files
            page.screenshot(path='/tmp/files_tab.png', full_page=False)
            print("   ✓ Files tab screenshot saved to /tmp/files_tab.png")
            
            # Check for empty directory message
            page_content = page.content()
            if 'Empty directory' in page_content:
                print("   ⚠ Files shows 'Empty directory' - may be an issue")
            else:
                print("   ✓ Files tab shows content")
        else:
            print("   ✗ Files tab not found")
        
        # Switch back to chat
        print("7. Switching back to Chat tab...")
        chat_tab = page.locator('button').filter(has_text='Chat').first
        if chat_tab.is_visible():
            chat_tab.click()
            time.sleep(0.5)
            print("   ✓ Back on Chat tab")
        
        # Check for console errors
        print("8. Checking console errors...")
        critical_errors = [e for e in console_errors if 'WebSocket' in e or 'TypeError' in e or 'ReferenceError' in e]
        if critical_errors:
            print(f"   ⚠ Found {len(critical_errors)} critical errors:")
            for err in critical_errors[:5]:
                print(f"     - {err[:100]}")
        else:
            print("   ✓ No critical console errors")
        
        browser.close()
        print("\n=== Test Complete ===")
        return len(critical_errors) == 0

if __name__ == '__main__':
    try:
        success = test_tabs()
        sys.exit(0 if success else 1)
    except Exception as e:
        print(f"\n✗ Test failed with error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
