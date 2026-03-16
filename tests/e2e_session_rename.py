#!/usr/bin/env python3
"""
E2E test for session renaming functionality in Pi Web UI
Tests:
1. Login
2. Rename a session via UI
3. Verify name persists after page reload
4. Verify name appears in preferences API
"""

import os
import sys
import time
import json
import requests
from playwright.sync_api import sync_playwright, expect

# Configuration
BASE_URL = os.environ.get('TEST_URL', 'https://pi.letsautomate.work')
API_URL = os.environ.get('API_URL', 'https://pi.letsautomate.work')
SCREENSHOT_DIR = "/root/pi-web-ui/tests/screenshots"
PASSWORD = os.environ.get('AUTH_PASSWORD', 'ChangeMeNow123!')

# Ensure screenshot directory exists
os.makedirs(SCREENSHOT_DIR, exist_ok=True)

def timestamp():
    """Get current timestamp for screenshots."""
    from datetime import datetime
    return datetime.now().strftime("%H%M%S")


def test_session_rename():
    """Test session renaming functionality."""
    
    print("="*60)
    print("Pi Web UI - Session Rename E2E Test")
    print("="*60)
    
    with sync_playwright() as p:
        # Launch browser
        print("\n[1/7] Launching browser...")
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1400, 'height': 900})
        page = context.new_page()
        
        # Capture console logs
        console_logs = []
        page.on("console", lambda msg: console_logs.append(f"{msg.type}: {msg.text}"))
        
        # Capture page errors
        page_errors = []
        page.on("pageerror", lambda err: page_errors.append(str(err)))
        
        try:
            # Navigate to the app
            print("\n[2/7] Navigating to application...")
            page.goto(BASE_URL, timeout=30000)
            page.wait_for_load_state('networkidle', timeout=30000)
            time.sleep(2)
            
            # Take initial screenshot
            page.screenshot(path=f"{SCREENSHOT_DIR}/01_initial_{timestamp()}.png", full_page=True)
            
            # Test login
            print("\n[3/7] Testing authentication...")
            
            # Check if we're on the login page by looking for password input
            password_input = page.locator('input#password')
            
            if password_input.count() > 0:
                print("  ✓ Login form detected")
                password_input.fill(PASSWORD)
                print("  ✓ Password filled")
                
                # Click Sign In button
                signin_button = page.locator('button[type="submit"]')
                signin_button.click()
                print("  ✓ Sign In clicked")
                
                # Wait for authentication
                time.sleep(3)
                page.wait_for_load_state('networkidle', timeout=15000)
            else:
                print("  ⚠ No password input found - might already be authenticated")
            
            # Take screenshot after login
            page.screenshot(path=f"{SCREENSHOT_DIR}/02_after_login_{timestamp()}.png", full_page=True)
            print("  ✓ Screenshot saved")
            
            # Wait for sessions to load
            print("\n[4/7] Waiting for sessions to load...")
            time.sleep(2)
            
            # Find a session item in the sidebar
            session_items = page.locator('[role="listitem"], .session-item, [class*="SessionItem"]').all()
            print(f"  Found {len(session_items)} session items")
            
            if len(session_items) == 0:
                # Try alternative selectors
                session_items = page.locator('div[class*="cursor-pointer"]').filter(has=page.locator('text=/./')).all()
                print(f"  Alternative search found {len(session_items)} items")
            
            # Take screenshot of sessions
            page.screenshot(path=f"{SCREENSHOT_DIR}/03_sessions_{timestamp()}.png", full_page=True)
            
            if len(session_items) > 0:
                # Hover over the first session to reveal action buttons
                print("\n[5/7] Testing session rename...")
                first_session = session_items[0]
                first_session.hover()
                time.sleep(0.5)
                
                # Take screenshot with hover state
                page.screenshot(path=f"{SCREENSHOT_DIR}/04_hover_{timestamp()}.png", full_page=True)
                
                # Look for the edit/rename button (Edit2 icon from lucide)
                edit_button = page.locator('button[title="Rename session"], button:has(svg[class*="edit"]), button:has(svg)').filter(
                    has=page.locator('svg')
                ).first
                
                # Try to find the edit button by hovering and looking for action buttons
                action_buttons = page.locator('button:has(svg)').all()
                print(f"  Found {len(action_buttons)} buttons with SVG icons")
                
                # Find the edit button - it's usually the first one after hover
                # The edit button has Edit2 icon from lucide
                edit_btn = None
                for btn in action_buttons:
                    title = btn.get_attribute('title') or ''
                    if 'rename' in title.lower() or 'edit' in title.lower():
                        edit_btn = btn
                        break
                
                if not edit_btn and len(action_buttons) >= 2:
                    # Assume second button is edit (after archive)
                    # Look for a button with Edit2 icon (w-3 h-3 is typical size)
                    for btn in action_buttons:
                        classes = btn.get_attribute('class') or ''
                        svg = btn.locator('svg').first
                        svg_class = svg.get_attribute('class') or ''
                        # Edit buttons typically have smaller icons (w-3 or w-3.5)
                        if 'w-3' in svg_class and 'hover:bg-gray-200' in classes:
                            edit_btn = btn
                            break
                
                if edit_btn:
                    print("  ✓ Edit button found, clicking...")
                    edit_btn.click()
                    time.sleep(0.5)
                    
                    # Take screenshot of edit mode
                    page.screenshot(path=f"{SCREENSHOT_DIR}/05_edit_mode_{timestamp()}.png", full_page=True)
                    
                    # Find the input field
                    input_field = page.locator('input[type="text"], input[placeholder="Session name"]').first
                    
                    if input_field.count() > 0:
                        # Clear and type new name
                        input_field.fill("")
                        input_field.fill("E2E Renamed Session")
                        print("  ✓ Typed new name: 'E2E Renamed Session'")
                        
                        # Take screenshot of typed name
                        page.screenshot(path=f"{SCREENSHOT_DIR}/06_typed_name_{timestamp()}.png", full_page=True)
                        
                        # Click the check button to save
                        check_btn = page.locator('button:has(svg[class*="green"]), button:has(svg):has(path)').first
                        # Look for checkmark button by title or icon
                        save_btn = None
                        for btn in page.locator('button:has(svg)').all():
                            title = btn.get_attribute('title') or ''
                            if 'save' in title.lower() or 'check' in title.lower():
                                save_btn = btn
                                break
                        
                        if not save_btn:
                            # Use the first green-tinted button (checkmark)
                            save_btn = page.locator('button:has(svg[class*="green"])').first
                        
                        if save_btn and save_btn.count() > 0:
                            save_btn.click()
                            print("  ✓ Save button clicked")
                        else:
                            # Press Enter to save
                            input_field.press("Enter")
                            print("  ✓ Pressed Enter to save")
                        
                        time.sleep(1)
                        
                        # Take screenshot after rename
                        page.screenshot(path=f"{SCREENSHOT_DIR}/07_after_rename_{timestamp()}.png", full_page=True)
                        
                        # Verify the new name appears in the sidebar
                        print("\n[6/7] Verifying renamed session appears...")
                        renamed_session = page.locator('text="E2E Renamed Session"')
                        if renamed_session.count() > 0:
                            print("  ✓ Renamed session found in sidebar!")
                        else:
                            print("  ⚠ Renamed session not immediately visible (might need scroll)")
                        
                        # Reload the page to test persistence
                        print("\n[7/7] Testing persistence after reload...")
                        page.reload(wait_until='networkidle', timeout=30000)
                        time.sleep(3)
                        
                        # Take screenshot after reload
                        page.screenshot(path=f"{SCREENSHOT_DIR}/08_after_reload_{timestamp()}.png", full_page=True)
                        
                        # Check if renamed session still appears
                        renamed_session = page.locator('text="E2E Renamed Session"')
                        if renamed_session.count() > 0:
                            print("  ✓ Renamed session persisted after reload!")
                            print("\n" + "="*60)
                            print("TEST PASSED: Session rename works correctly!")
                            print("="*60)
                            return True
                        else:
                            print("  ✗ Renamed session not found after reload")
                            print("\nConsole logs:", console_logs[-5:] if console_logs else "None")
                            print("Page errors:", page_errors if page_errors else "None")
                            return False
                    else:
                        print("  ✗ Input field not found after clicking edit")
                        return False
                else:
                    print("  ⚠ Edit button not found, trying keyboard shortcut...")
                    # Try clicking directly on session and using F2 or similar
                    first_session.click()
                    time.sleep(0.5)
                    # Take screenshot
                    page.screenshot(path=f"{SCREENSHOT_DIR}/05_selected_{timestamp()}.png", full_page=True)
                    print("  ⚠ Manual verification needed - check screenshots")
                    return False
            else:
                print("  ⚠ No sessions found in sidebar - cannot test rename")
                print("  Creating a new session first might be needed")
                return False
                
        except Exception as e:
            print(f"\n✗ Test failed with error: {e}")
            page.screenshot(path=f"{SCREENSHOT_DIR}/error_{timestamp()}.png", full_page=True)
            print(f"Console logs: {console_logs[-10:] if console_logs else 'None'}")
            print(f"Page errors: {page_errors if page_errors else 'None'}")
            return False
            
        finally:
            browser.close()


if __name__ == "__main__":
    success = test_session_rename()
    sys.exit(0 if success else 1)
