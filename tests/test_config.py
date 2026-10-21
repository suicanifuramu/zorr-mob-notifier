import unittest

import main


class LiveConfigTests(unittest.TestCase):
    def test_valid_live_config(self):
        token, guild_id, channel_id = main.resolve_live_config({
            "DISCORD_TOKEN": "  token-value  ",
            "GUILD_ID": "123",
            "CHANNEL_ID": "456",
        })
        self.assertEqual(token, "token-value")
        self.assertEqual((guild_id, channel_id), (123, 456))

    def test_missing_token_is_actionable(self):
        with self.assertRaises(main.ConfigError) as caught:
            main.resolve_live_config({"GUILD_ID": "123", "CHANNEL_ID": "456"})
        self.assertIn("DISCORD_TOKEN", str(caught.exception))

    def test_missing_ids_are_actionable(self):
        for values in [
            {"DISCORD_TOKEN": "token", "CHANNEL_ID": "456"},
            {"DISCORD_TOKEN": "token", "GUILD_ID": "123"},
        ]:
            with self.subTest(values=sorted(values)):
                with self.assertRaises(main.ConfigError) as caught:
                    main.resolve_live_config(values)
                self.assertIn("must be set", str(caught.exception))

    def test_malformed_ids_are_rejected(self):
        cases = [
            ("GUILD_ID", "not-a-number"),
            ("CHANNEL_ID", "0"),
            ("GUILD_ID", "²"),  # isdigit() is true, but not ASCII decimal
            ("CHANNEL_ID", "12 34"),
            ("GUILD_ID", "123.0"),
            ("CHANNEL_ID", "-5"),
        ]
        for name, value in cases:
            values = {"DISCORD_TOKEN": "token", "GUILD_ID": "123", "CHANNEL_ID": "456"}
            values[name] = value
            with self.subTest(name=name, value=value):
                with self.assertRaises(main.ConfigError) as caught:
                    main.resolve_live_config(values)
                self.assertIn(name, str(caught.exception))

    def test_module_defaults_ignore_malformed_ids(self):
        self.assertEqual(main._settings_int("UNSET_SETTING"), 0)
        self.assertEqual(main._parse_id("²"), None)
        self.assertEqual(main._parse_id(" 123 "), 123)
        self.assertEqual(main._parse_id("0"), None)
        self.assertEqual(main._parse_id("9" * 5000), None)


class ApiTokenTests(unittest.TestCase):
    def test_api_token_is_required_only_when_requested(self):
        with self.assertRaises(main.ConfigError) as caught:
            main.require_api_token({})
        self.assertIn("API_TOKEN", str(caught.exception))
        self.assertEqual(main.require_api_token({"API_TOKEN": " secret "}), "secret")


if __name__ == "__main__":
    unittest.main()
