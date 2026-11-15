"""Local-only browser regressions; never use a user's profile or photographs."""
from functools import partial
import base64
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import random
import re
import struct
import tempfile
import threading
import unittest
import zipfile

from PIL import Image, IptcImagePlugin, PngImagePlugin
from PIL.TiffImagePlugin import IFDRational
from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BROWSER = os.environ.get("IMAGE_UTILITIES_TEST_BROWSER", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


class ImageUtilitiesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.temp.name)
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(ROOT)))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://localhost:{cls.server.server_port}/"
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(executable_path=BROWSER)
        image = Image.new("RGB", (120, 80), (40, 120, 170))
        image.save(cls.dir / "plain.png")
        image.save(cls.dir / "plain.jpg", quality=98)
        Image.new("RGB", (80, 60), (40, 120, 170)).save(cls.dir / "small.png")
        image = Image.new("RGB", (120, 80), (255, 0, 0))
        image.paste((0, 0, 255), (60, 0, 120, 80))
        exif = Image.Exif()
        exif[0x0112] = 6
        exif[0x010F] = "JustTools test camera"
        exif[0x013B] = '<img src="https://example.invalid/private-location">local artist'
        exif[0x8769] = {0x9003: "2024:06:15 12:34:56", 0xA002: 120, 0xA003: 80}
        exif[0x8825] = {
            1: "N", 2: (IFDRational(47), IFDRational(36), IFDRational(30)),
            3: "W", 4: (IFDRational(122), IFDRational(19), IFDRational(30)),
        }
        image.save(cls.dir / "tagged.jpg", quality=98, exif=exif)
        preview = io.BytesIO()
        image.resize((12, 8)).save(preview, format="JPEG")
        cls.embedded_preview = preview.getvalue()
        rich_exif = Image.Exif()
        rich_exif.load(exif.tobytes())
        photo = rich_exif.get_ifd(0x8769)
        photo[0x927C] = b"Opaque private camera preview: " + cls.embedded_preview
        rich_exif[0x8769] = photo
        payload = bytearray(rich_exif.tobytes())
        endian = ">" if payload[6:8] == b"MM" else "<"
        ifd = 6 + struct.unpack_from(endian + "I", payload, 10)[0]
        count = struct.unpack_from(endian + "H", payload, ifd)[0]
        struct.pack_into(endian + "I", payload, ifd + 2 + count * 12, len(payload) - 6)
        thumbnail_offset = len(payload) - 6 + 42
        payload += struct.pack(endian + "H", 3)
        payload += struct.pack(endian + "HHI", 0x0103, 3, 1) + struct.pack(endian + "H", 6) + b"\0\0"
        payload += struct.pack(endian + "HHII", 0x0201, 4, 1, thumbnail_offset)
        payload += struct.pack(endian + "HHII", 0x0202, 4, 1, len(cls.embedded_preview))
        payload += struct.pack(endian + "I", 0) + cls.embedded_preview
        rich = io.BytesIO()
        image.save(rich, format="JPEG", quality=98, exif=bytes(payload))
        cls.preview_text = base64.b64encode(cls.embedded_preview)
        xmp = ('''<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
          <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"
            xmlns:tiff="http://ns.adobe.com/tiff/1.0/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"
            xmlns:xmpGImg="http://ns.adobe.com/xap/1.0/g/img/" tiff:Orientation="6" tiff:ImageWidth="120" tiff:ImageHeight="80">
            <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Fixture caf\u00e9</rdf:li></rdf:Alt></dc:title>
            <xmp:Thumbnails><rdf:Alt><rdf:li rdf:parseType="Resource">
              <xmpGImg:width>12</xmpGImg:width><xmpGImg:height>8</xmpGImg:height><xmpGImg:format>JPEG</xmpGImg:format>
              <xmpGImg:image>''' + cls.preview_text.decode() + '''</xmpGImg:image>
            </rdf:li></rdf:Alt></xmp:Thumbnails>
          </rdf:Description></rdf:RDF></x:xmpmeta>''').encode()
        packet = b"http://ns.adobe.com/xap/1.0/\0" + xmp
        author = b"Fixture wire author"
        iptc = b"\x1c\x02\x50" + struct.pack(">H", len(author)) + author
        resource = b"Photoshop 3.0\0" + b"8BIM\x04\x04\0\0" + struct.pack(">I", len(iptc)) + iptc
        if len(iptc) % 2:
            resource += b"\0"
        (cls.dir / "with-previews.jpg").write_bytes(
            b"\xff\xd8\xff\xed" + struct.pack(">H", len(resource) + 2) + resource +
            b"\xff\xe1" + struct.pack(">H", len(packet) + 2) + packet + rich.getvalue()[2:])
        exif[0x0112] = 1
        exif[0x8825] = {
            1: "N", 2: (IFDRational(0), IFDRational(0), IFDRational(0)),
            3: "E", 4: (IFDRational(0), IFDRational(0), IFDRational(0)),
        }
        text = PngImagePlugin.PngInfo()
        text.add_text("Comment", "Private fixture comment")
        image.save(cls.dir / "tagged.png", pnginfo=text, exif=exif)
        image.save(cls.dir / "tagged.webp", lossless=True, exif=exif)
        noise = Image.frombytes("RGB", (800, 600), random.Random(42).randbytes(800 * 600 * 3))
        noise.save(cls.dir / "noise.png")
        large_exif = Image.Exif()
        large_exif[0x010F] = "JustTools test camera"
        large_exif[0x8769] = {0x9286: b"ASCII\0\0\0" + b"Retained private comment. " * 500, 0xA002: 800, 0xA003: 600}
        noise.save(cls.dir / "large-metadata.png", exif=large_exif)
        broken = b"Exif\0\0MM\0*\xff\xff\xff\xff"
        (cls.dir / "broken-metadata.jpg").write_bytes(
            b"\xff\xd8\xff\xe1" + struct.pack(">H", len(broken) + 2) + broken + (cls.dir / "plain.jpg").read_bytes()[2:])
        logo = Image.new("RGBA", (20, 10), (255, 0, 0, 0))
        logo.paste((255, 0, 0, 255), (4, 2, 16, 8))
        logo.save(cls.dir / "logo.png")
        Image.new("RGBA", (80, 60), (0, 0, 0, 0)).save(cls.dir / "transparent.png")
        Image.new("RGB", (80, 4000), (40, 120, 170)).save(cls.dir / "portrait.png")
        Image.new("RGB", (4000, 80), (40, 120, 170)).save(cls.dir / "wide.png")

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def setUp(self):
        self.context = self.browser.new_context(accept_downloads=True, viewport={"width": 1440, "height": 1000})
        self.requests = []
        self.errors = []
        self.context.on("request", lambda request: self.requests.append((request.method, request.url)))
        self.page = self.context.new_page()
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.goto(self.url)
        expect(self.page.locator("#app-version")).to_contain_text("(ready)")
        self.downloads = 0

    def tearDown(self):
        try:
            self.assertEqual(self.errors, [])
            requests = [(method, url) for method, url in self.requests if not url.startswith("edge://")]
            self.assertTrue(all(method == "GET" and (url.startswith(self.url) or url.startswith("blob:" + self.url))
                                for method, url in requests), requests)
        finally:
            self.context.close()

    def idle(self):
        expect(self.page.locator("#cancel")).to_be_hidden(timeout=180000)

    def add(self, *names):
        previous = self.page.locator(".image-card").count()
        self.page.locator("#files").set_input_files([self.dir / name for name in names])
        expect(self.page.locator(".image-card")).to_have_count(previous + len(names))
        self.idle()
        expect(self.page.locator("#preview-surface")).to_be_visible()

    def section(self, title):
        summary = self.page.locator("summary").filter(has_text=re.compile("^" + re.escape(title) + "$"))
        if summary.evaluate("element => !element.parentElement.open"):
            summary.click()

    def value(self, id, value):
        self.page.locator(f"#{id}").evaluate("""(element, value) => {
          element.value = value;
          element.dispatchEvent(new Event('input', {bubbles: true}));
        }""", str(value))

    def process(self, success=True):
        self.page.locator("#process").click()
        self.idle()
        if success:
            self.assertTrue(self.page.locator("#error").is_hidden(), self.page.locator("#error").text_content())
            expect(self.page.locator("#download-zip")).to_be_enabled()
        else:
            expect(self.page.locator("#error")).to_be_visible()

    def save(self, control="download-one"):
        with self.page.expect_download() as event:
            self.page.locator(f"#{control}").click()
        self.downloads += 1
        folder = self.dir / f"{self.id().split('.')[-1]}-{self.downloads}"
        folder.mkdir(exist_ok=True)
        path = folder / event.value.suggested_filename
        event.value.save_as(path)
        self.idle()
        return path

    def test_result_gallery_shows_processed_pixels_and_downloads_viewed_image(self):
        self.add("plain.png", "tagged.png")
        self.page.locator("#add-cover").click()
        self.section("Resize & convert")
        self.page.locator("#format").select_option("png")
        self.page.locator("#resize").check()
        self.page.locator("#width").fill("60")
        self.process()
        cards = self.page.locator(".result-card")
        expect(cards).to_have_count(2)
        expect(cards.locator(".card-name")).to_have_text(["plain-processed.png", "tagged-processed.png"])
        expect(self.page.locator("#output-count")).to_have_text("2 OF 2 READY")
        thumbnail = cards.first.locator("img")
        thumbnail.evaluate("image => image.decode()")
        pixel = thumbnail.evaluate("""image => {
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
          const context = canvas.getContext('2d');
          context.drawImage(image, 0, 0);
          return Array.from(context.getImageData(30, 20, 1, 1).data);
        }""")
        self.assertEqual(pixel, [17, 24, 39, 255])

        self.page.locator("#view-original").click()
        self.page.locator("#draw-cover").click()
        self.page.locator("#select-none").click()
        expect(cards).to_have_count(2)
        trigger = cards.nth(1).locator(".thumb-button")
        trigger.click()
        expect(self.page.locator("#result-dialog")).to_be_visible()
        expect(self.page.locator("#result-title")).to_have_text("tagged-processed.png")
        image = self.page.locator("#result-full-image")
        image.evaluate("image => image.decode()")
        self.assertEqual(image.evaluate("image => [image.naturalWidth, image.naturalHeight]"), [60, 40])
        output = self.save("download-preview")
        self.assertEqual(output.name, "tagged-processed.png")
        with Image.open(output) as saved:
            self.assertEqual(saved.size, (60, 40))
            self.assertEqual(saved.convert("RGB").getpixel((10, 10)), (255, 0, 0))
        self.page.keyboard.press("Escape")
        expect(self.page.locator("#result-dialog")).to_be_hidden()
        expect(trigger).to_be_focused()
        expect(image).not_to_have_attribute("src", re.compile(".+"))
        trigger = cards.first.locator(".thumb-button")
        trigger.focus()
        trigger.press("Enter")
        expect(self.page.locator("#result-title")).to_have_text("plain-processed.png")
        self.page.locator("#close-result").click()
        with self.page.expect_download() as event:
            cards.first.locator(".card-actions [data-action='download']").click()
        direct = self.dir / "gallery-direct-download.png"
        event.value.save_as(direct)
        with Image.open(direct) as saved:
            self.assertEqual(saved.convert("RGB").getpixel((30, 20)), (17, 24, 39))

    def test_result_gallery_refreshes_in_order_and_releases_removed_outputs(self):
        self.add("plain.png", "tagged.png")
        self.process()
        cards = self.page.locator(".result-card")
        self.page.evaluate("""() => {
          const revoke = URL.revokeObjectURL;
          window.revokedResults = [];
          URL.revokeObjectURL = url => { window.revokedResults.push(url); revoke.call(URL, url); };
        }""")
        old_thumbnail = cards.first.locator("img").get_attribute("src")
        cards.first.locator(".thumb-button").click()
        old_image = self.page.locator("#result-full-image").get_attribute("src")
        self.page.locator("#close-result").click()
        self.page.locator("#select-none").click()
        self.page.locator(".image-card").first.locator("[data-select]").check()
        self.process()
        expect(cards).to_have_count(2)
        expect(cards.locator(".card-name")).to_have_text(["plain-processed.png", "tagged-processed.png"])
        revoked = self.page.evaluate("() => window.revokedResults")
        self.assertIn(old_thumbnail, revoked)
        self.assertIn(old_image, revoked)
        self.assertNotEqual(cards.first.locator("img").get_attribute("src"), old_thumbnail)
        self.page.locator("#view-original").click()
        self.page.locator("#add-cover").click()
        expect(cards).to_have_count(1)
        expect(cards.locator(".card-name")).to_have_text("tagged-processed.png")
        remaining_thumbnail = cards.first.locator("img").get_attribute("src")
        self.page.locator("#clear").click()
        expect(cards).to_have_count(0)
        expect(self.page.locator("#results")).to_be_hidden()
        self.assertIn(remaining_thumbnail, self.page.evaluate("() => window.revokedResults"))

    def test_result_gallery_omits_failed_inputs(self):
        self.add("noise.png", "plain.png")
        self.section("Resize & convert")
        self.page.locator("#format").select_option("jpeg")
        self.section("Compress")
        self.page.locator("#target").check()
        self.page.locator("#target-size").fill("10")
        self.page.locator("#allow-shrink").uncheck()
        self.process(success=False)
        expect(self.page.locator(".image-card.failed")).to_have_count(1)
        expect(self.page.locator(".result-card")).to_have_count(1)
        expect(self.page.locator(".result-card .card-name")).to_have_text("plain-processed.jpg")
        expect(self.page.locator("#output-count")).to_have_text("1 OF 2 READY")

    def test_full_result_viewer_fits_and_zooms_on_desktop_and_mobile(self):
        self.add("portrait.png", "wide.png")
        self.process()
        for width, height in [(1440, 1000), (390, 844)]:
            self.page.set_viewport_size({"width": width, "height": height})
            for index, dimensions in enumerate([(80, 4000), (4000, 80)]):
                self.page.locator(".result-card").nth(index).locator(".thumb-button").click()
                dialog = self.page.locator("#result-dialog")
                image = self.page.locator("#result-full-image")
                image.evaluate("image => image.decode()")
                expect(self.page.locator("#result-zoom")).to_have_text("Actual size (100%)")
                self.assertEqual(image.evaluate("image => [image.naturalWidth, image.naturalHeight]"), list(dimensions))
                fit = image.bounding_box()
                viewport = self.page.locator("#result-viewport").bounding_box()
                self.assertLessEqual(fit["width"], viewport["width"])
                self.assertLessEqual(fit["height"], viewport["height"])
                self.assertEqual(image.evaluate("image => getComputedStyle(image).objectFit"), "contain")
                self.assertLessEqual(dialog.bounding_box()["width"], width)
                self.assertLessEqual(dialog.bounding_box()["height"], height)
                self.page.locator("#result-zoom").click()
                expect(self.page.locator("#result-zoom")).to_have_text("Fit to window")
                actual = image.bounding_box()
                self.assertAlmostEqual(actual["width"], dimensions[0], delta=1)
                self.assertAlmostEqual(actual["height"], dimensions[1], delta=1)
                self.assertTrue(self.page.evaluate("() => document.documentElement.scrollWidth <= innerWidth"))
                self.page.locator("#result-zoom").click()
                expect(self.page.locator("#result-zoom")).to_have_text("Actual size (100%)")
                self.assertLessEqual(image.bounding_box()["width"], viewport["width"])
                self.assertLessEqual(image.bounding_box()["height"], viewport["height"])
                self.page.locator("#result-zoom").click()
                for _ in range(5):
                    self.page.keyboard.press("Tab")
                    # Native dialogs also allow focus to move to the browser toolbar.
                    self.assertTrue(self.page.evaluate("() => !document.hasFocus() || !!document.activeElement.closest('#result-dialog')"))
                self.page.keyboard.press("Escape")
                expect(dialog).to_be_hidden()

    def test_sidebar_picker_and_collapsed_tools_keep_settings(self):
        sidebar = self.page.locator(".sidebar").bounding_box()
        workbench = self.page.locator(".workbench").bounding_box()
        picker = self.page.locator(".sidebar #add-files")
        picker_bounds = picker.bounding_box()
        self.assertLessEqual(sidebar["x"] + sidebar["width"], workbench["x"])
        self.assertLess(picker_bounds["x"] + picker_bounds["width"], workbench["x"])
        expect(self.page.locator("#settings > .tool[open]")).to_have_count(0)
        expect(self.page.locator("#settings > .tool > summary")).to_have_text([
            "Resize & convert", "Compress", "Background removal", "Batch watermarking", "Privacy",
        ])
        with self.page.expect_file_chooser() as event:
            picker.click()
        event.value.set_files(self.dir / "plain.png")
        expect(self.page.locator(".image-card")).to_have_count(1)
        self.idle()

        summary = self.page.locator("#settings > .tool > summary").first
        summary.focus()
        summary.press("Enter")
        expect(self.page.locator("#format")).to_be_visible()
        expect(self.page.locator("#resize-fields")).to_be_hidden()
        self.page.locator("#format").select_option("webp")
        self.page.locator("#resize").check()
        expect(self.page.locator("#resize-fields")).to_be_visible()
        self.page.locator("#width").fill("60")
        self.page.locator("#resize").uncheck()
        expect(self.page.locator("#resize-fields")).to_be_hidden()
        self.page.locator("#resize").check()
        expect(self.page.locator("#width")).to_have_value("60")

        self.section("Compress")
        expect(self.page.locator("#settings > .tool[open]")).to_have_count(1)
        expect(self.page.locator("#format")).to_be_hidden()
        expect(self.page.locator("#target-fields")).to_be_hidden()
        self.page.locator("#target").check()
        expect(self.page.locator("#target-fields")).to_be_visible()
        self.page.locator("#target-size").fill("20")
        self.page.locator("#target").uncheck()
        expect(self.page.locator("#target-fields")).to_be_hidden()
        self.page.locator("#target").check()
        expect(self.page.locator("#target-size")).to_have_value("20")

        self.section("Batch watermarking")
        expect(self.page.locator("#watermark-fields")).to_be_hidden()
        self.page.locator("#watermark-kind").select_option("text")
        expect(self.page.locator("#watermark-fields")).to_be_visible()
        self.page.locator("#watermark-text").fill("Keep this setting")
        self.page.locator("#watermark-kind").select_option("none")
        expect(self.page.locator("#watermark-fields")).to_be_hidden()
        self.page.locator("#watermark-kind").select_option("text")
        expect(self.page.locator("#watermark-text")).to_have_value("Keep this setting")
        self.page.locator("#watermark-kind").select_option("none")

        self.section("Privacy")
        self.page.locator("#neutral-names").check()
        self.page.locator("#settings > .tool[open] > summary").click()
        expect(self.page.locator("#settings > .tool[open]")).to_have_count(0)
        self.process()
        output = self.save()
        self.assertEqual(output.name, "image-001.webp")
        self.assertLessEqual(output.stat().st_size, 20 * 1024)
        with Image.open(output) as image:
            self.assertEqual(image.format, "WEBP")
            self.assertEqual(image.size, (60, 40))
        self.section("Resize & convert")
        expect(self.page.locator("#width")).to_have_value("60")
        expect(self.page.locator("#download-one")).to_be_enabled()

    def test_mobile_sidebar_drop_keeps_image_selection_accessible(self):
        self.page.set_viewport_size({"width": 390, "height": 844})
        sidebar = self.page.locator(".sidebar").bounding_box()
        workbench = self.page.locator(".workbench").bounding_box()
        self.assertLessEqual(sidebar["y"] + sidebar["height"], workbench["y"])
        expect(self.page.locator(".sidebar #add-files")).to_be_visible()
        transfer = self.page.evaluate_handle("""bytes => {
          const transfer = new DataTransfer();
          transfer.items.add(new File([new Uint8Array(bytes)], "dropped.png", {type: "image/png"}));
          return transfer;
        }""", list((self.dir / "plain.png").read_bytes()))
        try:
            self.page.dispatch_event("#add-files", "dragover", {"dataTransfer": transfer})
            expect(self.page.locator(".import-panel")).to_have_class(re.compile(r"\bdrag-over\b"))
            self.page.dispatch_event("#add-files", "drop", {"dataTransfer": transfer})
            expect(self.page.locator(".image-card")).to_have_count(1)
            self.idle()
            expect(self.page.locator(".import-panel")).not_to_have_class(re.compile(r"\bdrag-over\b"))
        finally:
            transfer.dispose()
        self.section("Resize & convert")
        self.page.locator("#resize").check()
        self.page.locator("#width").fill("60")
        self.assertTrue(self.page.evaluate("() => document.documentElement.scrollWidth <= innerWidth"))
        self.process()
        with Image.open(self.save()) as image:
            self.assertEqual(image.size, (60, 40))

    def test_gps_metadata_removal_preserves_orientation_and_original(self):
        expect(self.page.locator("#remove-metadata")).to_be_checked()
        path = self.dir / "tagged.jpg"
        original_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        self.add("tagged.jpg")
        self.section("Read GPS & metadata")
        expect(self.page.locator("#metadata-summary")).to_contain_text("GPS found: 47.608333, -122.325000")
        self.idle()
        self.assertIn("JustTools test camera", self.page.locator("#metadata").text_content())
        self.assertEqual(self.page.locator("#metadata img").count(), 0)
        self.section("Resize & convert")
        self.page.locator("#format").select_option("png")
        self.process()
        output = self.save()
        with Image.open(output) as image:
            self.assertEqual(image.size, (80, 120))
            self.assertEqual(dict(image.getexif()), {})
            red, blue = image.convert("RGB").getpixel((40, 10)), image.convert("RGB").getpixel((40, 100))
            self.assertGreater(red[0], 220)
            self.assertGreater(blue[2], 220)
        self.page.locator("#read-result-metadata").click()
        expect(self.page.locator("#metadata-summary")).to_contain_text("No GPS coordinates found")
        self.idle()
        self.assertNotIn("JustTools test camera", self.page.locator("#metadata").text_content())
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), original_hash)
        self.assertFalse(any("/vendor/exiftool/" in url for _, url in self.requests))

    def test_keep_metadata_preserves_tags_orientation_and_removes_previews(self):
        path = self.dir / "with-previews.jpg"
        original_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        self.add(path.name)
        self.page.locator("#add-cover").click()
        self.section("Privacy")
        self.page.locator("#remove-metadata").uncheck()
        expect(self.page.locator("#keep-metadata-note")).to_be_visible()
        self.section("Resize & convert")
        self.page.locator("#resize").check()
        self.page.locator("#width").fill("40")
        for format in ("jpeg", "png", "webp"):
            with self.subTest(format=format):
                self.section("Resize & convert")
                self.page.locator("#format").select_option(format)
                self.process()
                expect(self.page.locator("#status")).to_contain_text("Supported metadata was kept")
                output = self.save()
                with Image.open(output) as image:
                    self.assertEqual(image.size, (40, 60))
                    tags = image.getexif()
                    self.assertEqual(tags[0x0112], 1)
                    self.assertEqual(tags[0x010F], "JustTools test camera")
                    self.assertIn("local artist", tags[0x013B])
                    self.assertEqual((tags[0x0100], tags[0x0101]), image.size)
                    photo = tags.get_ifd(0x8769)
                    self.assertNotIn(0x927C, photo)
                    self.assertEqual(photo[0x9003], "2024:06:15 12:34:56")
                    self.assertEqual((photo[0xA002], photo[0xA003]), image.size)
                    gps = tags.get_ifd(0x8825)
                    self.assertEqual(gps[1], "N")
                    self.assertEqual(gps[3], "W")
                    self.assertEqual(tuple(map(float, gps[2])), (47, 36, 30))
                    self.assertGreater(image.convert("RGB").getpixel((20, 5))[0], 200)
                    self.assertGreater(image.convert("RGB").getpixel((20, 55))[2], 200)
                    self.assertLess(max(image.convert("RGB").getpixel((20, 30))), 75)
                    if image.format == "JPEG":
                        self.assertEqual(IptcImagePlugin.getiptcinfo(image)[(2, 80)], b"Fixture wire author")
                data = output.read_bytes()
                self.assertNotIn(self.embedded_preview, data)
                self.assertNotIn(self.preview_text, data)
                self.assertIn("Fixture caf\u00e9".encode(), data)
                self.section("Read GPS & metadata")
                self.idle()
                self.page.locator("#read-result-metadata").click()
                self.idle()
                expect(self.page.locator("#metadata-summary")).to_contain_text("Result (metadata kept): GPS found: 47.608333, -122.325000")
                self.assertNotIn("Thumbnails", self.page.locator("#metadata").text_content())
                self.assertEqual(self.page.locator("#metadata img").count(), 0)
                self.page.locator(".result-card .thumb-button").click()
                full = self.page.locator("#result-full-image")
                full.evaluate("image => image.decode()")
                self.assertEqual(full.evaluate("image => [image.naturalWidth, image.naturalHeight]"), [40, 60])
                self.page.locator("#close-result").click()
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), original_hash)

    def test_keep_metadata_handles_png_webp_plain_images_and_toggle(self):
        self.add("tagged.png", "tagged.webp", "plain.png")
        self.process()
        expect(self.page.locator(".result-card")).to_have_count(3)
        self.section("Privacy")
        self.page.locator("#remove-metadata").uncheck()
        expect(self.page.locator(".result-card")).to_have_count(0)
        expect(self.page.locator("#download-zip")).to_be_disabled()
        self.process()
        expect(self.page.locator(".result-card").nth(2).locator(".metadata-note")).to_have_text("No compatible metadata was available to copy.")
        with zipfile.ZipFile(self.save("download-zip")) as archive:
            self.assertEqual(len(archive.namelist()), 3)
            for name in ("tagged-processed.png", "tagged-processed.webp"):
                with Image.open(io.BytesIO(archive.read(name))) as image:
                    tags = image.getexif()
                    self.assertEqual(tags[0x010F], "JustTools test camera")
                    gps = tags.get_ifd(0x8825)
                    self.assertEqual(tuple(map(float, gps[2])), (0, 0, 0))
                    self.assertEqual(tuple(map(float, gps[4])), (0, 0, 0))
                    if image.format == "PNG":
                        self.assertEqual(image.info["Comment"], "Private fixture comment")
            with Image.open(io.BytesIO(archive.read("plain-processed.png"))) as image:
                self.assertEqual(image.size, (120, 80))
                self.assertNotIn(0x8825, image.getexif())
        self.page.locator("#remove-metadata").check()
        expect(self.page.locator(".result-card")).to_have_count(0)
        expect(self.page.locator("#keep-metadata-note")).to_be_hidden()
        self.process()
        expect(self.page.locator(".metadata-note")).to_have_count(0)
        with zipfile.ZipFile(self.save("download-zip")) as archive:
            for name in archive.namelist():
                with Image.open(io.BytesIO(archive.read(name))) as image:
                    self.assertFalse(image.getexif())
                    self.assertNotIn("Comment", image.info)

    def test_kept_metadata_counts_toward_target_size(self):
        self.add("large-metadata.png")
        self.section("Privacy")
        self.page.locator("#remove-metadata").uncheck()
        self.section("Resize & convert")
        self.page.locator("#format").select_option("jpeg")
        self.section("Compress")
        self.page.locator("#target").check()
        self.page.locator("#target-size").fill("20")
        self.process()
        output = self.save()
        self.assertLessEqual(output.stat().st_size, 20 * 1024)
        with Image.open(output) as image:
            self.assertLess(image.width, 800)
            photo = image.getexif().get_ifd(0x8769)
            self.assertGreater(len(photo[0x9286]), 12000)
            self.assertEqual((photo[0xA002], photo[0xA003]), image.size)
        self.page.locator("#target-size").fill("2")
        self.process(success=False)
        expect(self.page.locator("#error")).to_contain_text("Retained metadata also counts toward the limit")
        expect(self.page.locator("#download-zip")).to_be_disabled()
        expect(self.page.locator(".result-card")).to_have_count(0)
        self.section("Privacy")
        self.page.locator("#remove-metadata").check()
        self.process()
        output = self.save()
        self.assertLessEqual(output.stat().st_size, 2 * 1024)
        with Image.open(output) as image:
            self.assertFalse(image.getexif())

    def test_metadata_failures_do_not_silently_strip_and_can_recover(self):
        self.add("tagged.jpg")
        self.section("Privacy")
        self.page.locator("#remove-metadata").uncheck()
        route = "**/vendor/exiftool/zeroperl.wasm"
        self.context.route(route, lambda request: request.fulfill(status=503, body="Unavailable"))
        self.process(success=False)
        expect(self.page.locator("#error")).to_contain_text("Could not load local metadata support")
        expect(self.page.locator("#download-zip")).to_be_disabled()
        expect(self.page.locator("#remove-metadata")).not_to_be_checked()
        self.context.unroute(route)
        self.process()
        with Image.open(self.save()) as image:
            self.assertEqual(image.getexif()[0x010F], "JustTools test camera")
        self.page.locator("#clear").click()
        self.add("broken-metadata.jpg")
        self.process(success=False)
        expect(self.page.locator("#error")).to_contain_text("Could not preserve metadata")
        expect(self.page.locator(".result-card")).to_have_count(0)
        self.page.locator("#remove-metadata").check()
        self.process()
        with Image.open(self.save()) as image:
            self.assertFalse(image.getexif())

    def test_metadata_cancellation_terminates_worker_and_retries(self):
        self.add("tagged.jpg")
        self.section("Privacy")
        self.page.locator("#remove-metadata").uncheck()
        route = "**/metadata-worker.js*"
        self.context.route(route, lambda request: request.fulfill(
            content_type="text/javascript",
            body="self.onmessage = ({data}) => self.postMessage({id:data.id,type:'progress',message:'Waiting for metadata cancellation'});"))
        self.page.locator("#process").click()
        expect(self.page.locator("#status")).to_have_text("Waiting for metadata cancellation")
        self.page.locator("#cancel").click()
        self.idle()
        expect(self.page.locator("#status")).to_contain_text("Cancelled")
        expect(self.page.locator("#download-zip")).to_be_disabled()
        expect(self.page.locator("#remove-metadata")).not_to_be_checked()
        self.context.unroute(route)
        self.process()
        with Image.open(self.save()) as image:
            self.assertEqual(image.getexif()[0x010F], "JustTools test camera")

    def test_png_webp_zero_coordinates_and_clean_zip_metadata(self):
        self.add("tagged.png", "tagged.webp")
        self.section("Read GPS & metadata")
        expect(self.page.locator("#metadata-summary")).to_contain_text("GPS found: 0.000000, 0.000000")
        self.idle()
        self.page.locator(".image-card").nth(1).locator(".card-actions [data-action='inspect']").click()
        self.page.locator("#read-original-metadata").click()
        expect(self.page.locator("#metadata-summary")).to_contain_text("GPS found: 0.000000, 0.000000")
        self.idle()
        self.section("Resize & convert")
        self.page.locator("#format").select_option("png")
        self.process()
        with zipfile.ZipFile(self.save("download-zip")) as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual(len(archive.namelist()), 2)
            for name in archive.namelist():
                with Image.open(io.BytesIO(archive.read(name))) as image:
                    self.assertEqual(dict(image.getexif()), {})
                    self.assertNotIn("Comment", image.info)
                    self.assertNotIn("exif", image.info)

    def test_batch_resize_convert_unique_zip_and_stale_results(self):
        self.add("plain.png", "plain.jpg")
        self.section("Resize & convert")
        self.page.locator("#format").select_option("webp")
        self.page.locator("#resize").check()
        self.page.locator("#width").fill("60")
        self.process()
        with zipfile.ZipFile(self.save("download-zip")) as archive:
            self.assertEqual(archive.namelist(), ["plain-processed.webp", "plain-processed-2.webp"])
            self.assertIsNone(archive.testzip())
            for name in archive.namelist():
                with Image.open(io.BytesIO(archive.read(name))) as image:
                    self.assertEqual(image.format, "WEBP")
                    self.assertEqual(image.size, (60, 40))
        self.page.locator("#format").select_option("jpeg")
        expect(self.page.locator("#download-zip")).to_be_disabled()
        expect(self.page.locator("#result-count")).to_have_text("0 of 2 results ready")
        expect(self.page.locator(".result-card")).to_have_count(0)
        expect(self.page.locator("#results")).to_be_hidden()
        self.section("Privacy")
        self.page.locator("#neutral-names").check()
        self.process()
        with zipfile.ZipFile(self.save("download-zip")) as archive:
            self.assertEqual(archive.namelist(), ["image-001.jpg", "image-002.jpg"])

    def test_target_size_failure_resizing_and_quality_only(self):
        self.add("noise.png")
        self.section("Resize & convert")
        self.page.locator("#format").select_option("jpeg")
        self.section("Compress")
        self.page.locator("#target").check()
        self.page.locator("#target-size").fill("10")
        self.page.locator("#allow-shrink").uncheck()
        self.process(success=False)
        self.assertIn("target cannot be met", self.page.locator("#error").text_content())
        expect(self.page.locator("#download-zip")).to_be_disabled()
        self.page.locator("#allow-shrink").check()
        self.process()
        output = self.save()
        self.assertLessEqual(output.stat().st_size, 10 * 1024)
        with Image.open(output) as image:
            self.assertLess(image.width, 800)
            self.assertLess(image.height, 600)
        self.page.locator("#target-size").fill("200")
        self.page.locator("#allow-shrink").uncheck()
        self.process()
        output = self.save()
        self.assertLessEqual(output.stat().st_size, 200 * 1024)
        with Image.open(output) as image:
            self.assertEqual(image.size, (800, 600))

    def test_batch_text_and_logo_watermarks(self):
        self.add("plain.png", "small.png")
        self.section("Batch watermarking")
        self.page.locator("#watermark-kind").select_option("text")
        self.page.locator("#watermark-text").fill("Local test")
        self.page.locator("#watermark-color").fill("#ff0000")
        self.page.locator("#watermark-position").select_option("top-left")
        self.page.locator("#watermark-size").fill("15")
        self.value("watermark-opacity", 100)
        self.process()
        with zipfile.ZipFile(self.save("download-zip")) as archive:
            for name in archive.namelist():
                with Image.open(io.BytesIO(archive.read(name))) as image:
                    red = sum(count for count, (r, g, b) in image.convert("RGB").getcolors(image.width * image.height)
                              if r > 150 and g < 100 and b < 100)
                    self.assertGreater(red, 15)
        self.page.locator("#watermark-kind").select_option("logo")
        self.page.locator("#watermark-logo").set_input_files(self.dir / "logo.png")
        self.idle()
        self.page.locator("#watermark-size").fill("20")
        self.page.locator("#watermark-position").select_option("bottom-right")
        self.process()
        with Image.open(self.save()) as image:
            self.assertEqual(image.convert("RGB").getpixel((106, 72)), (255, 0, 0))
            self.assertEqual(image.convert("RGB").getpixel((10, 10)), (40, 120, 170))

    def test_quality_compression_and_png_webp_target_sizes(self):
        self.add("noise.png")
        self.section("Resize & convert")
        self.page.locator("#format").select_option("jpeg")
        self.section("Compress")
        self.value("quality", 100)
        self.process()
        large = self.save().stat().st_size
        self.value("quality", 25)
        self.process()
        output = self.save()
        self.assertLess(output.stat().st_size, large)
        with Image.open(output) as image:
            self.assertEqual(image.size, (800, 600))
        self.page.locator("#target").check()
        self.page.locator("#target-size").fill("40")
        for format in ["png", "webp"]:
            self.section("Resize & convert")
            self.page.locator("#format").select_option(format)
            self.process()
            output = self.save()
            self.assertLessEqual(output.stat().st_size, 40 * 1024)
            with Image.open(output) as image:
                self.assertEqual(image.format.lower(), format)
                self.assertLessEqual(image.width, 800)
                self.assertLessEqual(image.height, 600)

    def test_pointer_and_keyboard_covers_are_opaque_and_undoable(self):
        self.add("plain.png")
        self.page.locator("#draw-cover").click()
        self.page.locator("#covers").scroll_into_view_if_needed()
        bounds = self.page.locator("#covers").bounding_box()
        self.page.mouse.move(bounds["x"] + bounds["width"] * .2, bounds["y"] + bounds["height"] * .2)
        self.page.mouse.down()
        self.page.mouse.move(bounds["x"] + bounds["width"] * .6, bounds["y"] + bounds["height"] * .6, steps=8)
        self.page.mouse.up()
        expect(self.page.locator("#covers [data-cover]")).to_have_count(1)
        for key, value in [("x", 10), ("y", 10), ("width", 20), ("height", 20)]:
            self.page.locator(f"#cover-{key}").fill(str(value))
        self.page.locator("#apply-cover").click()
        self.page.locator("#undo-cover").click()
        self.page.locator("#covers [data-cover]").click()
        self.assertAlmostEqual(float(self.page.locator("#cover-x").input_value()), 20, delta=.5)
        self.process()
        with Image.open(self.save()) as image:
            self.assertEqual(image.convert("RGB").getpixel((48, 32)), (17, 24, 39))
            self.assertEqual(image.convert("RGB").getpixel((110, 70)), (40, 120, 170))
        self.page.locator("#view-original").click()
        expect(self.page.locator("#add-cover")).to_be_enabled()
        self.page.locator("#add-cover").click()
        expect(self.page.locator("#covers [data-cover]")).to_have_count(2)
        self.page.locator("#delete-cover").click()
        expect(self.page.locator("#covers [data-cover]")).to_have_count(1)
        expect(self.page.locator("#download-one")).to_be_disabled()

    def test_jpeg_transparency_and_subset_selection(self):
        self.add("transparent.png", "plain.png")
        self.page.locator("#select-none").click()
        expect(self.page.locator("#process")).to_be_disabled()
        self.page.locator(".image-card").first.locator("[data-select]").check()
        self.section("Resize & convert")
        self.page.locator("#format").select_option("jpeg")
        self.process()
        expect(self.page.locator("#result-count")).to_have_text("1 of 2 results ready")
        with Image.open(self.save()) as image:
            self.assertEqual(image.format, "JPEG")
            self.assertEqual(image.convert("RGB").getpixel((40, 30)), (255, 255, 255))
        with zipfile.ZipFile(self.save("download-zip")) as archive:
            self.assertEqual(len(archive.namelist()), 1)

    def test_invalid_files_errors_and_mobile_layout(self):
        fake = self.dir / "not-an-image.png"
        fake.write_text('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/private"/></svg>', encoding="utf-8")
        self.page.locator("#files").set_input_files([fake, self.dir / "plain.png"])
        expect(self.page.locator(".image-card")).to_have_count(1)
        self.idle()
        expect(self.page.locator("#error")).to_contain_text("Unsupported image")
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.assertTrue(self.page.evaluate("() => document.documentElement.scrollWidth <= innerWidth"))
        self.process()
        self.assertTrue(self.save().is_file())
        self.page.locator("#clear").click()
        expect(self.page.locator(".image-card")).to_have_count(0)
        expect(self.page.locator("#download-zip")).to_be_disabled()
        self.assertEqual(self.page.evaluate("() => [localStorage.length, sessionStorage.length]"), [0, 0])

    def test_encoding_failure_and_cancellation_allow_retry(self):
        self.add("plain.png")
        self.page.evaluate("""() => {
          window.originalToBlob = HTMLCanvasElement.prototype.toBlob;
          HTMLCanvasElement.prototype.toBlob = function(callback) { setTimeout(() => callback(null), 0); };
        }""")
        self.process(success=False)
        expect(self.page.locator("#download-one")).to_be_disabled()
        self.page.evaluate("""() => {
          HTMLCanvasElement.prototype.toBlob = function(...args) {
            setTimeout(() => window.originalToBlob.apply(this, args), 250);
          };
        }""")
        self.page.locator("#process").click()
        self.page.locator("#cancel").click()
        self.idle()
        expect(self.page.locator("#status")).to_contain_text("Cancelled")
        expect(self.page.locator("#download-one")).to_be_disabled()
        self.page.evaluate("() => { HTMLCanvasElement.prototype.toBlob = window.originalToBlob; }")
        self.process()
        self.assertTrue(self.save().is_file())

    def test_real_local_face_detection_and_background_removal(self):
        self.page.locator("#files").set_input_files(ROOT / "tests" / "fixtures" / "astronaut.png")
        expect(self.page.locator(".image-card")).to_have_count(1)
        self.idle()
        self.page.locator("#detect-faces").click()
        self.idle()
        self.assertTrue(self.page.locator("#error").is_hidden(), self.page.locator("#error").text_content())
        covers = self.page.locator("#covers [data-cover]")
        self.assertGreaterEqual(covers.count(), 1)
        box = covers.first.evaluate("""element => Object.fromEntries(
          ['x','y','width','height'].map(key => [key, Number(element.getAttribute(key)) / 1000]))""")
        self.section("Privacy")
        self.page.locator("#auto-faces").check()
        self.section("Background removal")
        self.page.locator("#background").check()
        self.process()
        with Image.open(self.save()) as image:
            rgba = image.convert("RGBA")
            self.assertEqual(rgba.size, (512, 512))
            self.assertEqual(rgba.getchannel("A").getextrema(), (0, 255))
            self.assertLess(rgba.getpixel((0, 0))[3], 64)
            self.assertGreater(rgba.getpixel((250, 300))[3], 128)
            x = round((box["x"] + box["width"] / 2) * 512)
            y = round((box["y"] + box["height"] / 2) * 512)
            self.assertEqual(rgba.getpixel((x, y)), (17, 24, 39, 255))
        self.page.locator("#view-original").click()
        expect(self.page.locator("#clear-covers")).to_be_enabled()
        self.page.locator("#clear-covers").click()
        self.process()
        self.page.locator("#view-original").click()
        expect(self.page.locator("#covers [data-cover]")).to_have_count(0)

    def test_ai_model_failure_is_explicit_and_retry_works(self):
        self.add(ROOT / "tests" / "fixtures" / "astronaut.png")
        self.section("Background removal")
        self.page.locator("#background").check()
        self.context.route("**/u2netp.onnx", lambda route: route.abort())
        self.process(success=False)
        self.assertIn("Could not load local background removal", self.page.locator("#error").text_content())
        expect(self.page.locator("#download-one")).to_be_disabled()
        self.context.unroute("**/u2netp.onnx")
        self.process()
        with Image.open(self.save()) as image:
            self.assertEqual(image.convert("RGBA").getchannel("A").getextrema(), (0, 255))

    def test_extreme_aspect_previews_keep_covers_aligned(self):
        self.add("portrait.png", "wide.png")
        for index in [0, 1]:
            self.page.locator(".image-card").nth(index).locator(".card-actions [data-action='inspect']").click()
            expect(self.page.locator("#preview-surface")).to_be_visible()
            canvas = self.page.locator("#preview").bounding_box()
            overlay = self.page.locator("#covers").bounding_box()
            self.assertLessEqual(canvas["height"], 601)
            for key in ["x", "y", "width", "height"]:
                self.assertAlmostEqual(canvas[key], overlay[key], delta=1.5)
            self.assertTrue(self.page.evaluate("() => document.documentElement.scrollWidth <= innerWidth"))


if __name__ == "__main__":
    unittest.main()
