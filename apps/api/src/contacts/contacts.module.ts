import { Module } from '@nestjs/common';
import { ContactJobsService } from './contact-jobs.service';
import {
  ContactFieldsController,
  ContactJobsController,
  ContactSettingsController,
  ContactsController,
  ContactTagsController,
  SegmentsController,
} from './contacts.controller';
import { ContactsService } from './contacts.service';

@Module({
  controllers: [
    ContactsController,
    ContactTagsController,
    ContactFieldsController,
    ContactSettingsController,
    SegmentsController,
    ContactJobsController,
  ],
  providers: [ContactsService, ContactJobsService],
  exports: [ContactsService],
})
export class ContactsModule {}
