// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './CgUpdate.css';
import { useConnectionContext } from "../../context/ConnectionProvider";

import Scrollable from '../../components/molecules/Scrollable/Scrollable';

import ColoredLogoIcon from '../../components/atoms/icons/misc/Logo/logo.svg?react';

export default function CgUpdate(props: { view: "reload" | "releaseNotes", finishInstallation?: () => Promise<void> }) {
  const { view, finishInstallation } = props;
  const { setShowReleaseNotes } = useConnectionContext();

  const finishUpdate = async () => {
    if (finishInstallation) {
      await finishInstallation();
    }
  }

  let content: JSX.Element | undefined;
  if (view === "reload") {
    content = (
      <>
        <div className="cg-update-text">
          We changed some things, please reload the page to update.
        </div>
        <div className="flex justify-center mt-8">
          <button className="cg-update-btn" onClick={finishUpdate}>
            Reload
          </button>
        </div>
      </>
    );
  } else if (view === "releaseNotes") {
    content = (
      <>
        <Scrollable innerClassName="px-8">
          <div className="cg-update-changelog-caption">
            What's new?
          </div>
          <div className="cg-update-changelog-date">
            23.09.22
          </div>
          <div className="cg-update-changelog-field">
            <ul>
              <li>HUGE update! Public beta coming soon!</li>

              <li>Mobile Responsiveness is here!</li>
              <ul>
                <li>
                  You can now use Common Ground on the go! Visit Common Ground on any mobile device browser
                  (remember to copy your seed phrase to log in on another device!) and you can install the
                  webpage as a Web App to pin it to your mobile home screen. It works almost like a native app,
                  give it a go! If you have questions don't hesitate to ask in the CG help channel, and we will
                  be writing guides in the next weeks.
                </li>
              </ul>

              <li>Complete redesign</li>
              <ul>
                <li>
                  We're proud to present the refreshed brand and design of Common Ground. Almost everything was retouched
                  - let us know if we missed anything! We hope you love it as much as we do.
                </li>
              </ul>

              <li>Partnership with Fractal - verify your humanity with Fractal</li>
              <ul>
                <li>
                  We're proud to announce our partnership with Fractal, and we now support their uniqueness check.
                  This privacy-preserving, decentralized process with our friends at Fractal allows you to verify you
                  are a unique human. It helps us prevent bots on the platform, and will in future allow for new
                  methods of governance. Every user that verifies themselves (the process is easy and anonymous -
                  we respect your privacy!) is equipped with a verified human badge.
                </li>
              </ul>

              <li>Communities can now human gate</li>
              <ul>
                <li>
                  Any area can now not only be token-gated, but human gated! Simply enable it on the area settings and
                  only Fractal verified humans will be allowed to write in channels. Anyone else can still read what is
                  being written, but only humans can join in! Reduce your moderation headache and guarantee that everyone
                  is a unique human with one click.
                </li>
              </ul>

              <li>Personal blogging</li>
              <ul>
                <li>
                  Not only did we redesign the profile page, but every user on Common Ground can now use the blog post
                  functionality! Simply visit your profile and tap "New post" to get started. This feature is only
                  available to users verified with Fractal, so we don't have to worry about spam! You can discover what
                  others are writing from a new widget on the frontpage called the <i>People's blog;</i> apply to become a CG
                  Creator to have your blog posts featured here!
                </li>
              </ul>

              <li>Dedicated Social page</li>
              <ul>
                <li>
                  We've restructured Common Ground to streamline some things - you can now find DMs and followers on the new social page!
                </li>
              </ul>

              <li>Reworked community settings</li>
              <ul>
                <li>
                  We've restructured the community settings: admins can now access all options by tapping the community name
                  on your channel browser and easily access everything in one place.
                </li>
              </ul>

              <li>Streamlined channel browser</li>
              <ul>
                <li>
                  Every channel can now easily be equipped with an emoji, so we can streamline the UI of the channel list. Sleeker, simpler!
                </li>
              </ul>

              <li>Endless bug fixes</li>
              <ul>
                <li>
                  We're sure we've missed some, let us know if anything is not behaving as it should.
                </li>
              </ul>

              <li>Thanks for reading, more coming soon!</li>
            </ul>
          </div>

          <div className="cg-update-changelog-caption">
            What's new?
          </div>
          <div className="cg-update-changelog-date">
            29.07.22
          </div>
          <div className="cg-update-changelog-field">
            <ul>
              <li>We're proud to share the latest round of improvements, with some very highly requested features making it to the alpha, check it out!</li>
              <li>Add 🎦 Youtube videos and 🖼️ images to articles: With a slight delay, but good things take time!</li>
              <li>Add 🖼️ images directly into the chat in channels! Copy paste or upload images as attachments to your messages in channels.</li>
              <li>Edit, delete, sleeker &amp; better reaction options! Try it out by hovering a message in a channel</li>
              <li>Darker background, better contrast: We dimmed the lights, and avid readers will be thankful for it!</li>
            </ul>
          </div>

          <div className="cg-update-changelog-caption">
            What's new?
          </div>
          <div className="cg-update-changelog-date">
            17.07.22
          </div>
          <div className="cg-update-changelog-field">
            <ul>
              <li>Completely rebuilt multiple UI components to prepare for mobile optimization</li>
              <li>Articles now support rich text - use headers &amp; make text bold or italic, and add any links you need</li>
              <li>The channel manager has been improved and you can now reliably reorder channels and areas</li>
              <li>New communities are now properly showcased on the frontpage, and tags work properly</li>
              <li>Articles &amp; announcements are now showcased together on the frontpage so readers don't miss anything relevant</li>
              <li>For more information check out the announcement 😁⚡</li>
            </ul>
          </div>

          <div className="cg-update-changelog-caption">
            What's new?
          </div>
          <div className="cg-update-changelog-date">
            07.07.22
          </div>
          <div className="cg-update-changelog-field">
            <ul>
              <li>Added Optimism blockchain support</li>
            </ul>
          </div>

          <div className="cg-update-changelog-caption">
            What's new?
          </div>
          <div className="cg-update-changelog-date">
            06.07.22
          </div>
          <div className="cg-update-changelog-field">
            <ul>
              <li>Fixed some bugs</li>
              <ul>
                <li>Desktop notifications now show the correct profile image.</li>
                <li>User profile popovers and other menu items now behave more reliably.</li>
                <li>Audio in voice calls should now behave more reliably and no longer suddenly stop working.</li>
              </ul>
            </ul>
          </div>

          <div className="cg-update-changelog-caption">
            What's new?
          </div>
          <div className="cg-update-changelog-date">
            01.07.22
          </div>
          <div className="cg-update-changelog-field">
            <ul>
              <li>Introducing: An improved community lobby header</li>
              <ul>
                <li>Every community can now brand their community home by uploading a banner image and links to their other online platforms 🥰 Better branding and one source of truth of links for your members and guests to discover!</li>
              </ul>
              <li>Introducing: Emojis in the chat 🔥</li>
              <ul>
                <li>Finally 😂 the emoji picker in the chatbox now works as expected. Add emojis by tapping the smilie on the right hand side of the chat box.</li>
              </ul>
              <li>Introducing: Scrollbar reworked</li>
              <ul>
                <li>Do you hate shitty scrollbars as much as Jan does? Good! We now have a new, delightfully handcrafted one to give you a world class scrolling experience.</li>
              </ul>
            </ul>
          </div>

          <div className="cg-update-changelog-caption">
            What's new?
          </div>
          <div className="cg-update-changelog-date">
            23.06.22
          </div>
          <div className="cg-update-changelog-field">
            <ul>
              <li>Introducing: Community blogs</li>
              <ul>
                <li>Admins and editor roles can now write and publish articles and announcements on their community lobby</li>
                <li>Posts can be public, which are then also showcased on the CG frontpage for anyone to read</li>
                <li>Posts can be members-only, in which case only members of your community can read it and discover it on the frontpage</li>
                <li>Posts can be assigned to token-gated areas of your community, so only members who can access those areas can read the articles. Token-gated content, BOOM 💥</li>
                <li>We hope you write some articles and give us feedback, we'd love to hear it! 💖</li>
              </ul>
              <li>Introducing: Moderation features</li>
              <ul>
                <li>Don't worry about misbehaving users ✌️ Admins and Moderators can now warn, mute and even ban users from their communities. A warning sends a public reminder in the channel for the user to watch their behavior, muting prevents the user from writing messages, and banning ejects the user from your community for a set amount of time. Goodbye troublemakers! ⚠️</li>
              </ul>
              <li>Introducing: Community Links</li>
              <ul>
                <li>Communities can now publish links on their lobby - link to your website, twitter, and more! Set your links in the community page on the lobby. More lobby upgrades coming soon! 🥰</li>
              </ul>
            </ul>
          </div>

          <div className="cg-update-changelog-caption">
            What's new?
          </div>
          <div className="cg-update-changelog-date">
            17.06.22
          </div>
          <div className="cg-update-changelog-field">
            <ul>
              <li>Improved token gating</li>
              <ul>
                <li>Now supporting ERC20, ERC721 and ERC1155</li>
                <li>Up to two token gating rules can be combined</li>
              </ul>
            </ul>
          </div>

          <div className="cg-update-changelog-caption">
            What's new?
          </div>
          <div className="cg-update-changelog-date">
            14.06.22
          </div>
          <div className="cg-update-changelog-field">
            <ul>
              <li>A new and improved admin &amp; mod view on the user profile popover</li>
            </ul>
          </div>

          <div className="cg-update-changelog-caption">
            What's new?
          </div>
          <div className="cg-update-changelog-date">
            11.06.22
          </div>
          <div className="cg-update-changelog-field">
            <ul>
              <li>Added Arbitrum and Avalanche</li>
            </ul>
          </div>

          <div className="cg-update-changelog-caption">
            What's new?
          </div>
          <div className="cg-update-changelog-date">
            10.06.22
          </div>
          <div className="cg-update-changelog-field">
            <ul>
              <li>Added a login page - an intermediary step before the user onboarding process, where users can choose to setup their profile, or login with an existing key phrase.</li>
              <li>Added Members &amp; Roles page where admins and mods can assign roles to community members</li>
              <li>Deleting messages in community channels is now possible for admins and moderators</li>
              <li>Added a hover effect to community tiles on the left navigation bar</li>
              <li>Fixed automatic detection of NFT transfers to refresh access gating</li>
            </ul>
          </div>

          <div className="cg-update-changelog-caption">
            What's new?
          </div>
          <div className="cg-update-changelog-date">
            09.06.22
          </div>
          <div className="cg-update-changelog-field">
            <ul>
              <li>Fixed a bug in community posts where long messages expand out of the container and break the member list panel</li>
              <li>Fixed profile drawer bug where some of the content is hidden on smaller screens</li>
              <li>Improved offline visibilty in community member list</li>
              <li>Improved chat input field text color</li>
              <li>Improved follow and message buttons on the profile popup</li>
              <li>Scrollbar now disappears after two seconds</li>
              <li>Tab "Community Management" can now be used to update community info</li>
            </ul>
          </div>

          <div className="cg-update-changelog-caption">
            What's new?
          </div>
          <div className="cg-update-changelog-date">
            08.06.22
          </div>
          <div className="cg-update-changelog-field">
            <ul>
              <li>Added voice call manager widget</li>
              <li>Added homepage banners</li>
            </ul>
          </div>

          <div className="cg-update-changelog-caption">
            What's new?
          </div>
          <div className="cg-update-changelog-date">
            07.06.22
          </div>
          <div className="cg-update-changelog-field">
            <ul>
              <li>Improved performance of area access evaluation</li>
            </ul>
          </div>

          <div className="cg-update-changelog-caption">
            What's new?
          </div>
          <div className="cg-update-changelog-date">
            06.06.22
          </div>
          <div className="cg-update-changelog-field">
            <ul>
              <li>Added community NFTs as a requirement for creating communities</li>
              <li>Fixed an issue where the service for area gating checks would break</li>
            </ul>
          </div>

          <div className="cg-update-changelog-caption">
            What's new?
          </div>
          <div className="cg-update-changelog-date">
            02.06.22
          </div>
          <div className="cg-update-changelog-field">
            <ul>
              <li>Number of connectable wallets is now 5</li>
              <li>Fixed an issue where user alias would not update</li>
              <li>Areas are now visible for unjoined communities</li>
              <li>Fixed a bug preventing message updates for admins in gated channels</li>
              <li>Fixed a bug preventing new area members from showing up</li>
            </ul>
          </div>

          <div className="cg-update-changelog-caption">
            What's new?
          </div>
          <div className="cg-update-changelog-date">
            01.06.22
          </div>
          <div className="cg-update-changelog-field">
            <ul>
              <li>Automatic area access updates on role change</li>
              <li>Fixed an issue where the area gating editor would load rules incorrectly</li>
            </ul>
          </div>

          <div className="cg-update-changelog-caption">
            What's new?
          </div>
          <div className="cg-update-changelog-date">
            31.05.22
          </div>
          <div className="cg-update-changelog-field">
            <ul>
              <li>Added app version detection</li>
              <ul>
                <li>The app will now automatically inform the user when an update is required</li>
              </ul>
            </ul>
          </div>
        </Scrollable>

        <div className="flex justify-center pt-8">
          <button className="cg-update-btn" onClick={() => setShowReleaseNotes(false)}>
            Nice
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="background" />
      <div className="pending-state">
        <div className="wrapper">
          <div className="cg-update-info">
            <div className="flex items-center justify-center mb-8">
              <div>
                <ColoredLogoIcon />
              </div>
              <div className="cg-update-caption">
                Updates
              </div>
            </div>
            {content}
          </div>
        </div>
      </div>
    </>
  );
}