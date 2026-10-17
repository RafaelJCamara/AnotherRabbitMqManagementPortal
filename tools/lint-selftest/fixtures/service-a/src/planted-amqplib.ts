// PLANTED VIOLATION: amqplib is confined to adapter-amqp091 and apps/conformance.
import { connect } from 'amqplib';

export const planted = connect;
