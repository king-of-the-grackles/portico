// A new person signs in, picks a handle on the welcome page and sees their own Portico.
import { nonce } from "../lib/env";
import { expect, test } from "../lib/fixtures";
import { signIn } from "../lib/person";

test("a new person signs in, picks a handle and sees their Portico", async ({ world, browser }) => {
  // A new person every time, also when the rest of the cast is kept between runs.
  const carol = await world.descopeUser(`c${nonce(4)}`);
  const context = await browser.newContext();
  const page = await context.newPage();

  // Signed out, Portico sends the browser to the sign-in page, which loads Descope's component.
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in/);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to Portico" })).toBeVisible();
  await expect(page.locator("descope-wc")).toBeAttached();

  // The suite can't type into Descope's screen, so it hands Portico the session JWT the screen would have produced.
  const next = await signIn(context, carol.email);
  expect(next).toBe("/welcome");

  // First run: nothing opens before the handle is picked.
  await page.goto("/");
  await expect(page).toHaveURL(/\/welcome/);
  await expect(page.getByRole("heading", { level: 1, name: "Welcome to Portico" })).toBeVisible();
  await expect(page.getByLabel("Your name")).toHaveValue(carol.name);
  await page.getByLabel("Handle").fill(carol.handle);
  await page.getByRole("button", { name: "Continue" }).click();

  // The dashboard, with the person's own Portico in the side list.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
  await page.getByRole("link", { name: "Personal", exact: true }).click();
  await expect(page).toHaveURL(/\/p\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1, name: "Personal Portico" })).toBeVisible();

  // The handle shows in Settings.
  await page.goto("/settings");
  await expect(page.getByText(carol.handle).first()).toBeVisible();
  await context.close();
});
